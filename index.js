'use strict';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AUTH_DIR = path.join(__dirname, 'auth_baileys');
const POLL_INTERVAL_MS = 30_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ai = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ── People cache (refreshed every 5 min) ────────────────────────────────────
let _people = [];
let _peopleFetchedAt = 0;

async function getPeople() {
  if (Date.now() - _peopleFetchedAt > 5 * 60 * 1000) {
    const { data } = await supa.from('people').select('*').eq('is_active', true);
    if (data) { _people = data; _peopleFetchedAt = Date.now(); }
  }
  return _people;
}

async function findPersonByJid(jid) {
  const people = await getPeople();
  return people.find(p => p.whatsapp_number === jid && !p.is_bot) || null;
}

const NAME_ALIASES = {
  mum: 'Astrid', mom: 'Astrid', mama: 'Astrid', mother: 'Astrid',
  dad: 'Niko', papa: 'Niko', father: 'Niko',
};

async function findPersonByName(name) {
  const people = await getPeople();
  const resolved = NAME_ALIASES[name.toLowerCase()] || name;
  return people.find(p => p.name.toLowerCase() === resolved.toLowerCase() && !p.is_bot) || null;
}

// ── Message helpers ──────────────────────────────────────────────────────────
function getMessageText(msg) {
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || '';
}

function e164ToWaId(e164) {
  return e164.replace('+', '') + '@s.whatsapp.net';
}

// ── Messaging ────────────────────────────────────────────────────────────────
async function send(sock, jidOrNumber, message) {
  const jid = jidOrNumber.includes('@') ? jidOrNumber : e164ToWaId(jidOrNumber);
  await sock.sendMessage(jid, { text: message });
}

// ── Assignment rules ─────────────────────────────────────────────────────────
function isAutoAccept(sender, target) {
  if (sender.id === target.id) return true;
  if (sender.role === 'parent' && target.role === 'child') return true;
  return false;
}

// ── Pending actions ──────────────────────────────────────────────────────────
async function createPendingAction(personId, todoId, type, options) {
  await supa.from('pending_actions').delete()
    .eq('person_id', personId).eq('todo_id', todoId);
  await supa.from('pending_actions').insert({ person_id: personId, todo_id: todoId, type, options });
}

async function getPendingAction(personId) {
  const { data } = await supa.from('pending_actions').select('*')
    .eq('person_id', personId).order('created_at', { ascending: true }).limit(1);
  return data?.[0] || null;
}

async function getRefusedIds(todoId) {
  const { data } = await supa.from('todo_refusals').select('person_id').eq('todo_id', todoId);
  return new Set((data || []).map(r => r.person_id));
}

// ── Message builders ─────────────────────────────────────────────────────────
function buildAcceptRefuseMsg(todoText, assignerName) {
  return `📋 *${assignerName}* assigned you:\n"${todoText}"\n\nReply:\n1️⃣ Accept\n2️⃣ Refuse`;
}

async function buildReassignOptions(todo, justRefusedId) {
  const people = await getPeople();
  const refusedIds = await getRefusedIds(todo.id);
  refusedIds.add(justRefusedId);

  const creator = people.find(p => p.id === todo.created_by);
  const options = [];
  let num = 1;

  if (creator && !refusedIds.has(creator.id)) {
    options.push({ number: num++, label: `Take it myself (${creator.name})`, action: 'self' });
  }

  for (const p of people) {
    if (p.is_bot) continue;
    if (p.id === creator?.id) continue;
    if (refusedIds.has(p.id)) continue;
    options.push({ number: num++, label: p.name, action: 'assign', target_id: p.id });
  }

  options.push({ number: num++, label: '🗑️ Delete task', action: 'delete' });
  return options;
}

// ── Send assignment request ──────────────────────────────────────────────────
async function requestAcceptance(sock, todo, assigner, target) {
  if (!target.whatsapp_number) return;
  await send(sock, target.whatsapp_number, buildAcceptRefuseMsg(todo.text, assigner.name));
  await createPendingAction(target.id, todo.id, 'accept_refuse', [
    { number: 1, label: 'Accept', action: 'accept' },
    { number: 2, label: 'Refuse', action: 'refuse' },
  ]);
}

// ── Handle a pending action response ────────────────────────────────────────
async function handlePendingAction(sock, person, text) {
  const pending = await getPendingAction(person.id);
  if (!pending) return false;

  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || text.trim().length > 2) return false;

  const option = pending.options.find(o => o.number === num);
  if (!option) {
    await send(sock, person.whatsapp_number, `Please reply with one of the listed numbers.`);
    return true;
  }

  const { data: rows } = await supa.from('todos').select('*').eq('id', pending.todo_id).limit(1);
  const todo = rows?.[0];
  if (!todo) {
    await supa.from('pending_actions').delete().eq('id', pending.id);
    return true;
  }

  if (pending.type === 'accept_refuse') {
    await handleAcceptRefuse(sock, person, todo, option, pending);
  } else if (pending.type === 'reassign') {
    await handleReassign(sock, person, todo, option);
  }

  const next = await getPendingAction(person.id);
  if (next) {
    const { data: nextRows } = await supa.from('todos').select('*').eq('id', next.todo_id).limit(1);
    const nextTodo = nextRows?.[0];
    if (nextTodo) {
      const people = await getPeople();
      const assigner = people.find(p => p.id === nextTodo.created_by);
      await send(sock, person.whatsapp_number,
        buildAcceptRefuseMsg(nextTodo.text, assigner?.name || 'Someone'));
    }
  }

  return true;
}

async function handleAcceptRefuse(sock, person, todo, option, pending) {
  const people = await getPeople();

  if (option.action === 'accept') {
    await supa.from('todos').update({ assignment_status: 'accepted' }).eq('id', todo.id);
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(sock, person.whatsapp_number, `✅ Accepted: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (creator && creator.id !== person.id && creator.whatsapp_number) {
      await send(sock, creator.whatsapp_number, `✅ ${person.name} accepted: "${todo.text}"`);
    }
    console.log(`[${person.name}] Accepted: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'refuse') {
    await supa.from('todo_refusals').insert({ todo_id: todo.id, person_id: person.id });
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(sock, person.whatsapp_number, `❌ Refused: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (!creator?.whatsapp_number) return;

    const options = await buildReassignOptions(todo, person.id);
    const lines = [`❌ *${person.name}* refused:\n"${todo.text}"\n\nAssign to:`];
    options.forEach(o => lines.push(`${o.number}️⃣ ${o.label}`));
    await send(sock, creator.whatsapp_number, lines.join('\n'));
    await createPendingAction(creator.id, todo.id, 'reassign', options);
    console.log(`[${person.name}] Refused: ${todo.text.slice(0, 50)}`);
  }
}

async function handleReassign(sock, person, todo, option) {
  const people = await getPeople();
  await supa.from('pending_actions').delete().eq('person_id', person.id).eq('todo_id', todo.id);

  if (option.action === 'self') {
    await supa.from('todos')
      .update({ assigned_to: person.id, assignment_status: 'accepted' })
      .eq('id', todo.id);
    await send(sock, person.whatsapp_number, `✅ You'll handle: "${todo.text}"`);
    console.log(`[${person.name}] Took task: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'assign') {
    const target = people.find(p => p.id === option.target_id);
    if (!target) return;

    const autoAccept = isAutoAccept(person, target);
    await supa.from('todos')
      .update({ assigned_to: target.id, assignment_status: autoAccept ? 'accepted' : 'pending' })
      .eq('id', todo.id);

    if (autoAccept) {
      await send(sock, person.whatsapp_number, `✅ Assigned to ${target.name}: "${todo.text}"`);
      if (target.whatsapp_number) {
        await send(sock, target.whatsapp_number, `📋 *${person.name}* assigned you: "${todo.text}"`);
      }
    } else {
      await send(sock, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
      await requestAcceptance(sock, todo, person, target);
    }
    console.log(`[${person.name}→${target.name}] Reassigned: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'delete') {
    await supa.from('todos')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', todo.id);
    await send(sock, person.whatsapp_number, `🗑️ Deleted: "${todo.text}"`);
    console.log(`[${person.name}] Deleted: ${todo.text.slice(0, 50)}`);
  }
}

// ── Todo operations ──────────────────────────────────────────────────────────
async function addSelfTodo(sock, person, text) {
  const { error } = await supa.from('todos').insert({
    text,
    created_by: person.id,
    assigned_to: person.id,
    assignment_status: 'accepted',
    status: 'pending',
    processed: 0,
  });
  if (error) {
    console.error(`Failed to save todo for ${person.name}:`, error.message);
    await send(sock, person.whatsapp_number, 'Sorry, something went wrong. Try again?');
    return;
  }
  console.log(`[${person.name}] Todo added: ${text.slice(0, 60)}`);
  await send(sock, person.whatsapp_number, 'Got it ✓ Added to your todos.');
}

async function addAssignedTodo(sock, person, targetName, taskText) {
  const target = await findPersonByName(targetName);
  if (!target || target.id === person.id) return false;

  const autoAccept = isAutoAccept(person, target);
  const { data: inserted, error } = await supa.from('todos').insert({
    text: taskText,
    created_by: person.id,
    assigned_to: target.id,
    assignment_status: autoAccept ? 'accepted' : 'pending',
    status: 'pending',
    processed: 0,
  }).select().single();

  if (error) {
    console.error('Insert error:', error.message);
    await send(sock, person.whatsapp_number, 'Sorry, something went wrong.');
    return true;
  }

  if (autoAccept) {
    await send(sock, person.whatsapp_number, `✅ Assigned to ${target.name}: "${taskText}"`);
    if (target.whatsapp_number) {
      await send(sock, target.whatsapp_number, `📋 *${person.name}* assigned you: "${taskText}"`);
    }
  } else {
    await send(sock, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
    await requestAcceptance(sock, inserted, person, target);
  }

  console.log(`[${person.name}→${target.name}] ${autoAccept ? 'Auto-accepted' : 'Pending'}: ${taskText.slice(0, 50)}`);
  return true;
}

// ── Completion: mark numbered todos as done ──────────────────────────────────
async function handleCompletion(sock, person, numbers) {
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, someday: 3 };

  const { data: todos } = await supa.from('todos')
    .select('id, text, priority')
    .eq('assigned_to', person.id)
    .eq('status', 'pending')
    .eq('assignment_status', 'accepted');

  if (!todos?.length) {
    await send(sock, person.whatsapp_number, 'No pending todos to mark as done.');
    return;
  }

  todos.sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
  );

  const done = [];
  const invalid = [];

  for (const n of numbers) {
    const idx = n - 1;
    if (idx < 0 || idx >= todos.length) {
      invalid.push(n);
    } else {
      done.push(todos[idx]);
    }
  }

  if (!done.length) {
    await send(sock, person.whatsapp_number, `No matching todos (you have ${todos.length}).`);
    return;
  }

  const now = new Date().toISOString();
  for (const t of done) {
    await supa.from('todos').update({ status: 'done', updated_at: now }).eq('id', t.id);
  }

  const lines = done.map(t => `✅ ${t.text}`);
  if (invalid.length) lines.push(`\n(Numbers not found: ${invalid.join(', ')})`);
  await send(sock, person.whatsapp_number, lines.join('\n'));
  console.log(`[${person.name}] Completed ${done.length} todo(s): ${done.map(t => t.text.slice(0, 30)).join(', ')}`);
}

// ── Claude brain: classify inbound intent ────────────────────────────────────
const BRAIN_SYSTEM = `You are the inbox router for a family WhatsApp assistant. Classify each message into exactly one intent.

Intents:
- add_todo: A task to do later with no specific time ("buy milk", "call the plumber", "book a haircut")
- assign_todo: Starts with a family member name + colon, e.g. "Max: clean room"
- complete_todos: Purely numbers marking todos as done, e.g. "1", "1 3 5"
- diary: Creating, moving, or cancelling a calendar EVENT at a specific time/date
- reminder: Wants a WhatsApp ping at a specific time — NOT a calendar event ("remind me at 3pm to...", "ping me in an hour about...", "don't let me forget tonight to...")
- message_person: Wants to send a message to another family member ("tell Niko dinner is at 7", "ask Max if he has homework", "let Vicky know I'll be late")
- answer: Anything requiring an actual response — questions, research, recommendations, advice, drafts, general chat ("what monitor should I buy", "find hotels in Japan", "draft an email to the school", "how do I...")

Family members: Astrid (mum), Niko (dad), Max (15), Alex (13), Vicky (11). Vienna, Austria.

Rules:
- Pure digits/spaces → complete_todos
- Starts with name + colon → assign_todo
- DIARY: creating/moving/cancelling a calendar event with a time or date
- REMINDER: "remind me", "ping me", "don't let me forget", "in X hours/minutes" → even if it has a time, it's a reminder not a diary entry
- TODO: open-ended task, no time pressure, no response needed
- SEARCH: needs current/live data — weather, news, prices, restaurants, hotels, events, sports scores, anything that changes day to day
- ANSWER: does NOT need live data — drafting emails/messages, advice, explaining concepts, thinking through decisions, anything from general knowledge
- When unsure between todo and answer: if they'd expect a reply, it's answer or search

Respond with ONLY a JSON object:
{"intent": "add_todo", "task": "the todo text"}
{"intent": "assign_todo", "target": "Max", "task": "clean your room"}
{"intent": "complete_todos", "numbers": [1, 3]}
{"intent": "diary", "request": "the original request text"}
{"intent": "reminder", "request": "the original request text"}
{"intent": "message_person", "target": "Niko", "message": "dinner is at 7"}
{"intent": "search", "request": "the original request text"}
{"intent": "answer", "request": "the original request text"}`;

async function classifyMessage(person, text) {
  if (/^\d[\d\s]*$/.test(text.trim())) {
    const numbers = text.trim().split(/\s+/).map(Number);
    return { intent: 'complete_todos', numbers };
  }

  const assignMatch = text.match(/^(\w+)\s*:\s*(.+)$/s);
  if (assignMatch) {
    return { intent: 'assign_todo', target: assignMatch[1].trim(), task: assignMatch[2].trim() };
  }

  const reminderSignals = /\b(remind me|reminder|ping me|don.t let me forget|alert me|nudge me)\b/i;
  if (reminderSignals.test(text)) {
    return { intent: 'reminder', request: text };
  }

  const diarySignals = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|cancel\s|reschedule|move\s+\w+\s+to\b)\b/i;
  if (diarySignals.test(text)) {
    return { intent: 'diary', request: text };
  }

  if (!ai) {
    return { intent: 'add_todo', task: text };
  }

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: [
        {
          type: 'text',
          text: BRAIN_SYSTEM,
          cache_control: { type: 'ephemeral' },
        }
      ],
      messages: [
        { role: 'user', content: `Sender: ${person.name} (${person.role})\nMessage: ${text}` },
      ],
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Claude classification failed: ${e.message} — defaulting to add_todo`);
    return { intent: 'add_todo', task: text };
  }
}

// ── Diary / Google Calendar ──────────────────────────────────────────────────
const CALENDAR_ID = 'primary';
const CALENDAR_TIMEZONE = 'Europe/Vienna';

const CONTACTS = {
  astrid: 'astrid.woloszczuk@outlook.com',
  me: 'astrid.woloszczuk@outlook.com',
  alex: 'alexander.woloszczuk@gmail.com',
  alexander: 'alexander.woloszczuk@gmail.com',
  victoria: 'victoria.woloszczuk@gmail.com',
  vicky: 'victoria.woloszczuk@gmail.com',
  maximilian: 'maximilian.woloszczuk@gmail.com',
  max: 'maximilian.woloszczuk@gmail.com',
  niko: 'woloszczuk@stonepeak.com',
  nik: 'woloszczuk@stonepeak.com',
  niko_private: 'nwoloszczuk@gmail.com',
  boys: ['alexander.woloszczuk@gmail.com', 'maximilian.woloszczuk@gmail.com'],
  kids: ['alexander.woloszczuk@gmail.com', 'maximilian.woloszczuk@gmail.com', 'victoria.woloszczuk@gmail.com'],
  family: ['astrid.woloszczuk@outlook.com', 'woloszczuk@stonepeak.com', 'alexander.woloszczuk@gmail.com', 'maximilian.woloszczuk@gmail.com', 'victoria.woloszczuk@gmail.com'],
};

function resolveAttendees(text) {
  if (!text) return [];
  const emails = [];
  const t = text.toLowerCase();

  for (const phrase of ['all 5 of us', 'all of us', 'everyone', 'whole family', 'all family']) {
    if (t.includes(phrase)) emails.push(...CONTACTS.family);
  }
  for (const key of ['family', 'kids', 'boys']) {
    if (t.includes(key)) {
      const val = CONTACTS[key];
      emails.push(...(Array.isArray(val) ? val : [val]));
    }
  }
  if (t.includes('niko private')) {
    emails.push(CONTACTS.niko_private);
  } else if (t.includes('niko') || t.includes('nik')) {
    emails.push(CONTACTS.niko);
  }
  for (const alias of ['mum', 'mom', 'mama', 'mother']) {
    if (t.includes(alias)) { emails.push(CONTACTS.astrid); break; }
  }
  for (const alias of ['dad', 'papa', 'father']) {
    if (t.includes(alias)) { emails.push(CONTACTS.niko); break; }
  }
  for (const name of ['astrid', 'me', 'alex', 'alexander', 'victoria', 'vicky', 'maximilian', 'max']) {
    if (t.includes(name)) {
      const val = CONTACTS[name];
      if (val && typeof val === 'string') emails.push(val);
    }
  }

  return [...new Set(emails)];
}

function getCalendarClient() {
  const credPath = process.env.GOOGLE_CREDENTIALS_FILE || path.join(__dirname, 'google-credentials.json');
  const tokenPath = process.env.GOOGLE_TOKEN_FILE || path.join(__dirname, 'google-token.json');
  const credentials = JSON.parse(fs.readFileSync(credPath));
  const token = JSON.parse(fs.readFileSync(tokenPath));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  auth.setCredentials(token);
  auth.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(tokenPath));
    fs.writeFileSync(tokenPath, JSON.stringify({ ...current, ...tokens }, null, 2));
  });
  return google.calendar({ version: 'v3', auth });
}

function buildRrule(recurrence) {
  if (!recurrence) return null;
  const freq = (recurrence.frequency || 'WEEKLY').toUpperCase();
  const parts = [`FREQ=${freq}`];
  if (recurrence.days?.length) {
    const dayMap = { monday:'MO', tuesday:'TU', wednesday:'WE', thursday:'TH',
                     friday:'FR', saturday:'SA', sunday:'SU' };
    const byday = recurrence.days.map(d => dayMap[d.toLowerCase()] || d.toUpperCase().slice(0, 2)).join(',');
    parts.push(`BYDAY=${byday}`);
  }
  if (recurrence.until) {
    parts.push(`UNTIL=${recurrence.until.replace(/-/g, '')}T235959Z`);
  } else if (recurrence.count) {
    parts.push(`COUNT=${recurrence.count}`);
  }
  return 'RRULE:' + parts.join(';');
}

function addOneHour(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  d.setHours(d.getHours() + 1);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function findCalendarEvents(searchTerm, daysAhead = 60) {
  const cal = getCalendarClient();
  const now = new Date();
  const timeMax = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    q: searchTerm,
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 5,
  });
  return res.data.items || [];
}

async function parseCalendarRequest(person, text) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    timeZone: CALENDAR_TIMEZONE,
  });

  const prompt = `You are a calendar assistant. Parse this calendar request into a JSON action.

Today is ${today}.

Request: ${text}

Return ONLY a JSON object. For adding a one-time event:
{"action":"add","title":"event title","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","location":"location or null","attendees_raw":"names as written or null","description":"extra notes or null","recurrence":null}

For adding a recurring event:
{"action":"add","title":"event title","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","location":"location or null","attendees_raw":"names as written or null","description":"extra notes or null","recurrence":{"frequency":"WEEKLY","days":["friday"],"until":"YYYY-MM-DD"}}

Recurrence rules:
- frequency: DAILY, WEEKLY, or MONTHLY
- days: list of day names (only for WEEKLY), e.g. ["monday","wednesday"]
- until: end date as YYYY-MM-DD (use this if a specific end date is given)
- count: number of occurrences (only if no end date given)

For moving/rescheduling:
{"action":"move","search_term":"keyword to find event","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM or null"}

For cancelling/deleting:
{"action":"delete","search_term":"keyword to find event"}

If unclear:
{"action":"unclear","message":"what is unclear"}

Rules:
- "this friday" = the coming Friday, even if today is Friday
- "next tuesday" = Tuesday of next week
- If no end time, default to 1 hour after start
- If no title given, infer one from context
- date = first occurrence date`;

  const response = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  let raw = response.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

async function handleDiary(sock, person, text) {
  let parsed;
  try {
    parsed = await parseCalendarRequest(person, text);
  } catch (e) {
    console.error(`[${person.name}] Calendar parse error: ${e.message}`);
    await send(sock, person.whatsapp_number,
      "Sorry, I couldn't understand that. Try something like:\n• add dentist thursday 3pm\n• move tennis to saturday\n• cancel friday appointment");
    return;
  }

  const { action } = parsed;
  let reply;

  try {
    const cal = getCalendarClient();

    if (action === 'add') {
      const startDt = `${parsed.date}T${parsed.start_time}:00`;
      const endTime = parsed.end_time || addOneHour(parsed.start_time);
      const endDt = `${parsed.date}T${endTime}:00`;
      const rrule = buildRrule(parsed.recurrence);
      const attendees = resolveAttendees(parsed.attendees_raw);

      const event = {
        summary: parsed.title,
        start: { dateTime: startDt, timeZone: CALENDAR_TIMEZONE },
        end: { dateTime: endDt, timeZone: CALENDAR_TIMEZONE },
      };
      if (parsed.location) event.location = parsed.location;
      if (parsed.description) event.description = parsed.description;
      if (rrule) event.recurrence = [rrule];
      if (attendees.length) event.attendees = attendees.map(e => ({ email: e }));

      await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: event });

      reply = `✅ Done!\n\n*${parsed.title}*\n${parsed.date}  ${parsed.start_time}–${endTime}`;
      if (parsed.location) reply += `\n📍 ${parsed.location}`;
      if (attendees.length) reply += `\n👥 Invited: ${attendees.join(', ')}`;
      if (rrule && parsed.recurrence) {
        const days = (parsed.recurrence.days || [])
          .map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
        reply += `\n🔁 Repeats weekly${days ? ' on ' + days : ''}`;
        if (parsed.recurrence.until) reply += ` until ${parsed.recurrence.until}`;
      }

    } else if (action === 'move') {
      const events = await findCalendarEvents(parsed.search_term);
      if (!events.length) {
        reply = `Couldn't find an event matching "${parsed.search_term}". No changes made.`;
      } else {
        const event = events[0];
        const startDt = `${parsed.date}T${parsed.start_time}:00`;
        let endDt;
        if (parsed.end_time) {
          endDt = `${parsed.date}T${parsed.end_time}:00`;
        } else {
          const duration = new Date(event.end.dateTime) - new Date(event.start.dateTime);
          endDt = new Date(new Date(startDt).getTime() + duration).toISOString().slice(0, 19);
        }
        event.start = { dateTime: startDt, timeZone: CALENDAR_TIMEZONE };
        event.end = { dateTime: endDt, timeZone: CALENDAR_TIMEZONE };
        await cal.events.update({ calendarId: CALENDAR_ID, eventId: event.id, requestBody: event });
        reply = `✅ Moved *${event.summary}* to ${parsed.date} at ${parsed.start_time}.`;
      }

    } else if (action === 'delete') {
      const events = await findCalendarEvents(parsed.search_term);
      if (!events.length) {
        reply = `Couldn't find an event matching "${parsed.search_term}". Nothing deleted.`;
      } else {
        const event = events[0];
        await cal.events.delete({ calendarId: CALENDAR_ID, eventId: event.id });
        reply = `✅ Deleted *${event.summary}*.`;
      }

    } else {
      reply = `Sorry, I couldn't understand that. Try:\n• add dentist thursday 3pm\n• move tennis to saturday\n• cancel friday appointment`;
    }

  } catch (e) {
    console.error(`[${person.name}] Calendar action error: ${e.message}`);
    reply = `Something went wrong with the calendar. Please try again.`;
  }

  await send(sock, person.whatsapp_number, reply);
  console.log(`[${person.name}] Diary: ${action} → ${reply.slice(0, 60)}`);
}

// ── Ollama (local Qwen) ───────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const QWEN_MODEL = process.env.QWEN_CHAT_MODEL || 'qwen2.5:7b';

async function callOllama(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: QWEN_MODEL, prompt, stream: false }),
  });
  const data = await res.json();
  return data.response?.trim() || '';
}

// ── Search via local SearXNG ──────────────────────────────────────────────────
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080';

async function handleSearch(sock, person, text) {
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(text)}&format=json&categories=general&language=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const data = await res.json();

    const snippets = (data.results || []).slice(0, 5)
      .map(r => `${r.title}\n${r.content || ''}`.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!snippets) {
      console.log(`[${person.name}] Search returned no results — falling back to Claude`);
      return handleAnswer(sock, person, text);
    }

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Vienna', dateStyle: 'full', timeStyle: 'short' });
    const prompt = `You are James, a family assistant. Answer the question below using only the search results provided. Be concise and WhatsApp-friendly. Use bullet points (•) for lists. No preamble. Answer in the same language as the question.

Today: ${now} Vienna
Question: ${text}

Search results:
${snippets}

Answer:`;

    const reply = await callOllama(prompt);
    if (!reply) throw new Error('Empty Ollama response');
    await send(sock, person.whatsapp_number, reply);
    console.log(`[${person.name}] Search: ${reply.slice(0, 80)}`);
  } catch (e) {
    console.error(`[${person.name}] Search error: ${e.message} — falling back to Claude`);
    return handleAnswer(sock, person, text);
  }
}

// ── Answer: general questions, research, drafts ──────────────────────────────
const ANSWER_SYSTEM = `You are James, a family AI assistant reached via WhatsApp.
Family: Astrid (mum), Niko (dad), Victoria/Vicky (11), Alexander/Alex (13), Maximilian/Max (15). Vienna, Austria, 1130 Hietzing.
Keep replies concise and WhatsApp-friendly. Short paragraphs. Bullet points (•) for lists. No # headers. No preamble like "Sure!" or "Great question".
For research (hotels, restaurants, products): 3-5 concrete options with the key deciding details.
For email/message drafts: write the complete text, clearly marked with "--- Draft ---".
Answer in the same language the message was written in.`;

async function handleAnswer(sock, person, text) {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Vienna', dateStyle: 'full', timeStyle: 'short' });
  try {
    const response = await ai.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `${ANSWER_SYSTEM}\nCurrent date/time: ${now}\nSpeaking with: ${person.name}`,
      messages: [{ role: 'user', content: text }],
    });
    const reply = response.content[0].text.trim();
    await send(sock, person.whatsapp_number, reply);
    console.log(`[${person.name}] Answer: ${reply.slice(0, 80)}`);
  } catch (e) {
    console.error(`[${person.name}] Answer error: ${e.message}`);
    await send(sock, person.whatsapp_number, "Sorry, I couldn't get an answer right now. Try again?");
  }
}

// ── Reminders ────────────────────────────────────────────────────────────────
async function handleReminder(sock, person, text) {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Vienna', dateStyle: 'full', timeStyle: 'short' });
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Parse this reminder request. Current time: ${now} Vienna (Europe/Vienna timezone).
Request: "${text}"
Return ONLY JSON: {"remind_at": "ISO8601 datetime in UTC", "message": "concise reminder text", "reply": "friendly confirmation (include the time in Vienna local time)"}
If time is ambiguous, default to 1 hour from now.` }],
    });
    let raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw);
    await supa.from('reminders').insert({
      person_id: person.id,
      message: parsed.message,
      remind_at: parsed.remind_at,
    });
    await send(sock, person.whatsapp_number, `⏰ ${parsed.reply || "Got it, I'll remind you!"}`);
    console.log(`[${person.name}] Reminder set: "${parsed.message}" at ${parsed.remind_at}`);
  } catch (e) {
    console.error(`[${person.name}] Reminder error: ${e.message}`);
    await send(sock, person.whatsapp_number, "Sorry, I couldn't set that reminder. Try: \"remind me at 3pm to call the dentist\"");
  }
}

async function checkReminders(sock) {
  try {
    const now = new Date().toISOString();
    const { data: due } = await supa
      .from('reminders')
      .select('*, people(whatsapp_number, name)')
      .eq('sent', false)
      .lte('remind_at', now);
    if (!due?.length) return;
    for (const r of due) {
      const whatsapp = r.people?.whatsapp_number;
      if (!whatsapp) continue;
      await send(sock, whatsapp, `⏰ Reminder: ${r.message}`);
      await supa.from('reminders').update({ sent: true, sent_at: new Date().toISOString() }).eq('id', r.id);
      console.log(`[Reminder→${r.people.name}] ${r.message}`);
    }
  } catch (e) {
    console.error('Reminder poll error:', e.message);
  }
}

// ── Message a family member ───────────────────────────────────────────────────
async function handleMessagePerson(sock, person, classified) {
  const target = await findPersonByName(classified.target);
  if (!target || !target.whatsapp_number) {
    await send(sock, person.whatsapp_number, `Sorry, I don't have WhatsApp set up for ${classified.target}.`);
    return;
  }
  await send(sock, target.whatsapp_number, `📩 *${person.name}:* ${classified.message}`);
  await send(sock, person.whatsapp_number, `✅ Sent to ${target.name}.`);
  console.log(`[${person.name}→${target.name}] "${classified.message.slice(0, 60)}"`);
}

// ── Birthday "done" reply ────────────────────────────────────────────────────
async function handleBirthdayDone(sock, person) {
  const todayMMDD = new Date().toLocaleDateString('en-CA', { timeZone: CALENDAR_TIMEZONE }).slice(5);
  const todayISO  = new Date().toLocaleDateString('en-CA', { timeZone: CALENDAR_TIMEZONE });

  const { data: bdayRows } = await supa
    .from('birthdays').select('id, name').eq('birth_date', todayMMDD);
  if (!bdayRows?.length) return false;

  const confirmed = [];
  for (const bday of bdayRows) {
    const { data: rem } = await supa.from('birthday_reminders')
      .select('person_name').eq('birthday_id', bday.id).eq('person_name', person.name);
    if (!rem?.length) continue;

    const { data: ack } = await supa.from('birthday_acks')
      .select('id').eq('birthday_id', bday.id).eq('ack_date', todayISO).eq('acked_by', person.name);
    if (ack?.length) continue;

    await supa.from('birthday_acks').insert({
      birthday_id: bday.id, ack_date: todayISO, acked_by: person.name,
    });
    confirmed.push(bday.name);
  }

  if (!confirmed.length) return false;
  await send(sock, person.whatsapp_number, `🎂 Great, marked as done for: ${confirmed.join(', ')}!`);
  console.log(`[${person.name}] Birthday ack via WhatsApp: ${confirmed.join(', ')}`);
  return true;
}

// ── Main inbound handler ─────────────────────────────────────────────────────
async function handleInbound(sock, msg) {
  const text = getMessageText(msg).trim();
  if (!text) return;

  const jid = msg.key.remoteJid;
  console.log(`DEBUG JID: ${jid}`);

  const person = await findPersonByJid(jid);
  if (!person) {
    console.log(`Ignored message from unknown JID: ${jid}`);
    return;
  }

  const handled = await handlePendingAction(sock, person, text);
  if (handled) return;

  if (/^done\.?$/i.test(text)) {
    const bdayHandled = await handleBirthdayDone(sock, person);
    if (bdayHandled) return;
  }

  const classified = await classifyMessage(person, text);
  console.log(`[${person.name}] intent=${classified.intent} | "${text.slice(0, 60)}"`);

  switch (classified.intent) {
    case 'complete_todos':
      await handleCompletion(sock, person, classified.numbers);
      break;

    case 'assign_todo': {
      const assigned = await addAssignedTodo(sock, person, classified.target, classified.task);
      if (!assigned) {
        await addSelfTodo(sock, person, text);
      }
      break;
    }

    case 'diary':
      await handleDiary(sock, person, text);
      break;

    case 'add_todo':
      await addSelfTodo(sock, person, classified.task || text);
      break;

    case 'reminder':
      await handleReminder(sock, person, classified.request || text);
      break;

    case 'message_person':
      await handleMessagePerson(sock, person, classified);
      break;

    case 'search':
      await handleSearch(sock, person, classified.request || text);
      break;

    case 'answer':
    default:
      await handleAnswer(sock, person, classified.request || text);
      break;
  }
}

// ── Outbound message queue ───────────────────────────────────────────────────
async function sendPending(sock) {
  const { data: messages, error } = await supa
    .from('outbound_messages').select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) { console.error('Outbound poll error:', error.message); return; }
  if (!messages?.length) return;

  console.log(`Sending ${messages.length} pending message(s)...`);
  for (const msg of messages) {
    try {
      await sock.sendMessage(e164ToWaId(msg.to_number), { text: msg.message });
      await supa.from('outbound_messages')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', msg.id);
      console.log(`  Sent to ${msg.to_number}: ${msg.message.slice(0, 60)}`);
    } catch (e) {
      console.error(`  Failed to send to ${msg.to_number}:`, e.message);
      await supa.from('outbound_messages')
        .update({ status: 'failed', error: e.message })
        .eq('id', msg.id);
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'info' }),
    printQRInTerminal: false,
    browser: ['Mac OS', 'Chrome', '14.4.1'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR code needed — scan in WhatsApp (Settings → Linked Devices → Link a Device)');
      require('qrcode-terminal').generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp connected and ready.');
      console.log(ai ? 'Claude brain: active' : 'Claude brain: disabled (no ANTHROPIC_API_KEY)');
      sendPending(sock);
      checkReminders(sock);
      setInterval(() => { sendPending(sock); checkReminders(sock); }, POLL_INTERVAL_MS);
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.error('Logged out — delete auth_baileys/ folder and restart to re-scan QR');
        process.exit(1);
      }
      console.log('Reconnecting...');
      main();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      try {
        await handleInbound(sock, msg);
      } catch (e) {
        console.error('handleInbound error:', e.message);
      }
    }
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
