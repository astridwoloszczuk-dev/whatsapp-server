'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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

async function findPersonByNumber(number) {
  const people = await getPeople();
  return people.find(p => p.whatsapp_number === number && !p.is_bot) || null;
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

// ── Number helpers ───────────────────────────────────────────────────────────
function waIdToE164(waId) {
  return '+' + waId.split('@')[0];
}

function e164ToWaId(e164) {
  return e164.replace('+', '') + '@c.us';
}

async function resolveNumber(message) {
  if (message.from.endsWith('@lid')) {
    try {
      const contact = await message.getContact();
      return '+' + contact.number;
    } catch (e) {
      console.log(`Could not resolve LID ${message.from}: ${e.message}`);
      return null;
    }
  }
  return waIdToE164(message.from);
}

// ── Messaging ────────────────────────────────────────────────────────────────
async function send(client, number, message) {
  const numberId = await client.getNumberId(number.replace('+', ''));
  const chatId = numberId ? numberId._serialized : e164ToWaId(number);
  await client.sendMessage(chatId, message);
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
async function requestAcceptance(client, todo, assigner, target) {
  if (!target.whatsapp_number) return;
  await send(client, target.whatsapp_number, buildAcceptRefuseMsg(todo.text, assigner.name));
  await createPendingAction(target.id, todo.id, 'accept_refuse', [
    { number: 1, label: 'Accept', action: 'accept' },
    { number: 2, label: 'Refuse', action: 'refuse' },
  ]);
}

// ── Handle a pending action response ────────────────────────────────────────
async function handlePendingAction(client, person, text) {
  const pending = await getPendingAction(person.id);
  if (!pending) return false;

  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || text.trim().length > 2) return false;

  const option = pending.options.find(o => o.number === num);
  if (!option) {
    await send(client, person.whatsapp_number, `Please reply with one of the listed numbers.`);
    return true;
  }

  const { data: rows } = await supa.from('todos').select('*').eq('id', pending.todo_id).limit(1);
  const todo = rows?.[0];
  if (!todo) {
    await supa.from('pending_actions').delete().eq('id', pending.id);
    return true;
  }

  if (pending.type === 'accept_refuse') {
    await handleAcceptRefuse(client, person, todo, option, pending);
  } else if (pending.type === 'reassign') {
    await handleReassign(client, person, todo, option);
  }

  const next = await getPendingAction(person.id);
  if (next) {
    const { data: nextRows } = await supa.from('todos').select('*').eq('id', next.todo_id).limit(1);
    const nextTodo = nextRows?.[0];
    if (nextTodo) {
      const people = await getPeople();
      const assigner = people.find(p => p.id === nextTodo.created_by);
      await send(client, person.whatsapp_number,
        buildAcceptRefuseMsg(nextTodo.text, assigner?.name || 'Someone'));
    }
  }

  return true;
}

async function handleAcceptRefuse(client, person, todo, option, pending) {
  const people = await getPeople();

  if (option.action === 'accept') {
    await supa.from('todos').update({ assignment_status: 'accepted' }).eq('id', todo.id);
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(client, person.whatsapp_number, `✅ Accepted: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (creator && creator.id !== person.id && creator.whatsapp_number) {
      await send(client, creator.whatsapp_number, `✅ ${person.name} accepted: "${todo.text}"`);
    }
    console.log(`[${person.name}] Accepted: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'refuse') {
    await supa.from('todo_refusals').insert({ todo_id: todo.id, person_id: person.id });
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(client, person.whatsapp_number, `❌ Refused: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (!creator?.whatsapp_number) return;

    const options = await buildReassignOptions(todo, person.id);
    const lines = [`❌ *${person.name}* refused:\n"${todo.text}"\n\nAssign to:`];
    options.forEach(o => lines.push(`${o.number}️⃣ ${o.label}`));
    await send(client, creator.whatsapp_number, lines.join('\n'));
    await createPendingAction(creator.id, todo.id, 'reassign', options);
    console.log(`[${person.name}] Refused: ${todo.text.slice(0, 50)}`);
  }
}

async function handleReassign(client, person, todo, option) {
  const people = await getPeople();
  await supa.from('pending_actions').delete().eq('person_id', person.id).eq('todo_id', todo.id);

  if (option.action === 'self') {
    await supa.from('todos')
      .update({ assigned_to: person.id, assignment_status: 'accepted' })
      .eq('id', todo.id);
    await send(client, person.whatsapp_number, `✅ You'll handle: "${todo.text}"`);
    console.log(`[${person.name}] Took task: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'assign') {
    const target = people.find(p => p.id === option.target_id);
    if (!target) return;

    const autoAccept = isAutoAccept(person, target);
    await supa.from('todos')
      .update({ assigned_to: target.id, assignment_status: autoAccept ? 'accepted' : 'pending' })
      .eq('id', todo.id);

    if (autoAccept) {
      await send(client, person.whatsapp_number, `✅ Assigned to ${target.name}: "${todo.text}"`);
      if (target.whatsapp_number) {
        await send(client, target.whatsapp_number, `📋 *${person.name}* assigned you: "${todo.text}"`);
      }
    } else {
      await send(client, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
      await requestAcceptance(client, todo, person, target);
    }
    console.log(`[${person.name}→${target.name}] Reassigned: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'delete') {
    await supa.from('todos')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', todo.id);
    await send(client, person.whatsapp_number, `🗑️ Deleted: "${todo.text}"`);
    console.log(`[${person.name}] Deleted: ${todo.text.slice(0, 50)}`);
  }
}

// ── Todo operations ──────────────────────────────────────────────────────────
async function addSelfTodo(client, person, text) {
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
    await send(client, person.whatsapp_number, 'Sorry, something went wrong. Try again?');
    return;
  }
  console.log(`[${person.name}] Todo added: ${text.slice(0, 60)}`);
  await send(client, person.whatsapp_number, 'Got it ✓ Added to your todos.');
}

async function addAssignedTodo(client, person, targetName, taskText) {
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
    await send(client, person.whatsapp_number, 'Sorry, something went wrong.');
    return true;
  }

  if (autoAccept) {
    await send(client, person.whatsapp_number, `✅ Assigned to ${target.name}: "${taskText}"`);
    if (target.whatsapp_number) {
      await send(client, target.whatsapp_number, `📋 *${person.name}* assigned you: "${taskText}"`);
    }
  } else {
    await send(client, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
    await requestAcceptance(client, inserted, person, target);
  }

  console.log(`[${person.name}→${target.name}] ${autoAccept ? 'Auto-accepted' : 'Pending'}: ${taskText.slice(0, 50)}`);
  return true;
}

// ── Completion: mark numbered todos as done ──────────────────────────────────
// Format: pure numbers, e.g. "1", "1 3", "2 4 5"
// Matches against today's digest order (high→medium→low)
async function handleCompletion(client, person, numbers) {
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, someday: 3 };

  const { data: todos } = await supa.from('todos')
    .select('id, text, priority')
    .eq('assigned_to', person.id)
    .eq('status', 'pending')
    .eq('assignment_status', 'accepted');

  if (!todos?.length) {
    await send(client, person.whatsapp_number, 'No pending todos to mark as done.');
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
    await send(client, person.whatsapp_number, `No matching todos (you have ${todos.length}).`);
    return;
  }

  const now = new Date().toISOString();
  for (const t of done) {
    await supa.from('todos').update({ status: 'done', updated_at: now }).eq('id', t.id);
  }

  const lines = done.map(t => `✅ ${t.text}`);
  if (invalid.length) lines.push(`\n(Numbers not found: ${invalid.join(', ')})`);
  await send(client, person.whatsapp_number, lines.join('\n'));
  console.log(`[${person.name}] Completed ${done.length} todo(s): ${done.map(t => t.text.slice(0,30)).join(', ')}`);
}

// ── Claude brain: classify inbound intent ────────────────────────────────────
// Uses prompt caching on the system prompt to keep costs low.

const BRAIN_SYSTEM = `You are the inbox router for a family WhatsApp todo system. Your job is to classify each incoming message into exactly one intent.

Intents:
- add_todo: The person wants to add a task/todo for themselves (most common)
- assign_todo: The message starts with a family member's name followed by a colon, e.g. "Max: clean room"
- complete_todos: The message is purely numbers, e.g. "1", "1 3 5", "done 2" — marking todos as completed
- diary: The message is about scheduling something at a specific time or date (appointments, events, meetings)
- unknown: Anything else (greetings, questions, gibberish)

Family members: Astrid (mum), Niko (dad), Max (15), Alex (13), Vicky (11).

Rules:
- If the message is ONLY digits and spaces, intent is complete_todos
- If it starts with a name + colon, intent is assign_todo
- DIARY signals (any of these → diary): a time like 3pm/10:30, a day like monday/friday/thursday, words like appointment/meeting/calendar/dentist/doctor/school/party/dinner/lunch/flight/holiday/cancel/move/reschedule
- Todos are open-ended tasks with no specific time, e.g. "buy milk", "call the plumber"
- When in doubt between todo and diary: if there's a time or date, it's diary

Respond with ONLY a JSON object, no explanation:
{"intent": "add_todo", "task": "the todo text"}
{"intent": "assign_todo", "target": "Max", "task": "clean your room"}
{"intent": "complete_todos", "numbers": [1, 3]}
{"intent": "diary", "request": "the original request text"}
{"intent": "unknown"}`;

async function classifyMessage(person, text) {
  // Fast path: pure numbers — no API call needed
  if (/^\d[\d\s]*$/.test(text.trim())) {
    const numbers = text.trim().split(/\s+/).map(Number);
    return { intent: 'complete_todos', numbers };
  }

  // Fast path: "Name: task" pattern — no API call needed
  const assignMatch = text.match(/^(\w+)\s*:\s*(.+)$/s);
  if (assignMatch) {
    return { intent: 'assign_todo', target: assignMatch[1].trim(), task: assignMatch[2].trim() };
  }

  // Fast path: time or strong date signal → diary (no API call needed)
  const diarySignals = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|cancel\s|reschedule|move\s+\w+\s+to\b)\b/i;
  if (diarySignals.test(text)) {
    return { intent: 'diary', request: text };
  }

  // Use Claude if available, otherwise default to add_todo
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

    const raw = response.content[0].text.trim();
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

async function handleDiary(client, person, text) {
  let parsed;
  try {
    parsed = await parseCalendarRequest(person, text);
  } catch (e) {
    console.error(`[${person.name}] Calendar parse error: ${e.message}`);
    await send(client, person.whatsapp_number,
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

  await send(client, person.whatsapp_number, reply);
  console.log(`[${person.name}] Diary: ${action} → ${reply.slice(0, 60)}`);
}

// ── Birthday "done" reply ────────────────────────────────────────────────────
async function handleBirthdayDone(client, person) {
  const todayMMDD = new Date().toLocaleDateString('en-CA', { timeZone: CALENDAR_TIMEZONE }).slice(5); // MM-DD
  const todayISO  = new Date().toLocaleDateString('en-CA', { timeZone: CALENDAR_TIMEZONE }); // YYYY-MM-DD

  // Find birthdays today where this person is a reminder recipient and hasn't acked yet
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
    if (ack?.length) continue; // already acked

    await supa.from('birthday_acks').insert({
      birthday_id: bday.id, ack_date: todayISO, acked_by: person.name,
    });
    confirmed.push(bday.name);
  }

  if (!confirmed.length) return false;
  await send(client, person.whatsapp_number, `🎂 Great, marked as done for: ${confirmed.join(', ')}!`);
  console.log(`[${person.name}] Birthday ack via WhatsApp: ${confirmed.join(', ')}`);
  return true;
}

// ── Main inbound handler ─────────────────────────────────────────────────────
async function handleInbound(client, message) {
  const text = message.body.trim();
  if (!text) return;

  const number = await resolveNumber(message);
  if (!number) return;

  const person = await findPersonByNumber(number);
  if (!person) {
    console.log(`Ignored message from unknown number: ${number}`);
    return;
  }

  // Pending action responses (numbered replies within an active dialogue) take priority
  const handled = await handlePendingAction(client, person, text);
  if (handled) return;

  // Fast-path: "done" → check for birthday acks before full classification
  if (/^done\.?$/i.test(text)) {
    const bdayHandled = await handleBirthdayDone(client, person);
    if (bdayHandled) return;
  }

  // Classify intent
  const classified = await classifyMessage(person, text);
  console.log(`[${person.name}] intent=${classified.intent} | "${text.slice(0, 60)}"`);

  switch (classified.intent) {
    case 'complete_todos':
      await handleCompletion(client, person, classified.numbers);
      break;

    case 'assign_todo': {
      const assigned = await addAssignedTodo(client, person, classified.target, classified.task);
      if (!assigned) {
        // Target not found or is self — treat as self-todo with full text
        await addSelfTodo(client, person, text);
      }
      break;
    }

    case 'diary':
      await handleDiary(client, person, text);
      break;

    case 'add_todo':
      await addSelfTodo(client, person, classified.task || text);
      break;

    default:
      await addSelfTodo(client, person, text);
      break;
  }
}

// ── Outbound message queue ───────────────────────────────────────────────────
async function sendPending(client) {
  const { data: messages, error } = await supa
    .from('outbound_messages').select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) { console.error('Outbound poll error:', error.message); return; }
  if (!messages?.length) return;

  console.log(`Sending ${messages.length} pending message(s)...`);
  for (const msg of messages) {
    try {
      await client.sendMessage(e164ToWaId(msg.to_number), msg.message);
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
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/google-chrome-stable',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', qr => {
    console.log('\nScan this QR code in WhatsApp on the iPhone:');
    console.log('(WhatsApp → Settings → Linked Devices → Link a Device)\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('WhatsApp connected and ready.');
    if (ai) {
      console.log('Claude brain: active (prompt caching on)');
    } else {
      console.log('Claude brain: disabled (no ANTHROPIC_API_KEY) — using pattern matching only');
    }
    sendPending(client);
    setInterval(() => sendPending(client), POLL_INTERVAL_MS);
  });

  client.on('message', async message => {
    if (message.from.endsWith('@g.us')) return;
    if (message.from === 'status@broadcast') return;
    await handleInbound(client, message);
  });

  client.on('disconnected', reason => {
    console.warn('WhatsApp disconnected:', reason);
    process.exit(1);
  });

  await client.initialize();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
