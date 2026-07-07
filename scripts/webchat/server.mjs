#!/usr/bin/env node
// Local test harness — a WhatsApp stand-in chat UI for the clinic bot.
//
// It runs the SAME pipeline as n8n/workflow-a-inbound.json (find-or-create +
// message write + dedupe, triage/emergency/disclosure, pgvector RAG, Claude
// tool-calling, booking/handoff) against the live Postgres, so you can test the
// conversation without WhatsApp, Meta, or ngrok. Google Calendar is *simulated*
// here (appointments are written to the DB; no real calendar event) — that's the
// only difference from production, and it's labelled in the debug panel.
//
// Run:  npm run webchat        (reads .env for ANTHROPIC_API_KEY / OPENAI_API_KEY)
// Open: http://localhost:3000
//
// No keys? The DB/triage/emergency/disclosure flow still works; the panel tells
// you which keys are missing and Claude replies fall back to a stub.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (KEY=VALUE lines) -----------------------------------
try {
  const env = await readFile(join(HERE, '../../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env — fine */ }

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
// Generation provider: LLM_PROVIDER=anthropic|openai, else 'auto'/unset picks
// Claude if its key is set, otherwise ChatGPT. Embeddings always use OpenAI.
const RAW_PROVIDER = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
const PROVIDER = RAW_PROVIDER === 'auto'
  ? (ANTHROPIC_KEY ? 'anthropic' : (OPENAI_KEY ? 'openai' : 'none'))
  : RAW_PROVIDER;
const HAS_LLM = Boolean((PROVIDER === 'anthropic' && ANTHROPIC_KEY) || (PROVIDER === 'openai' && OPENAI_KEY));
const GEN_LABEL = PROVIDER === 'anthropic' ? MODEL : PROVIDER === 'openai' ? OPENAI_CHAT_MODEL : 'none';
const CLINIC_PHONE_ID = process.env.TEST_CLINIC_PHONE_ID || '1114486611757569'; // db/seed.sql
const PORT = Number(process.env.WEBCHAT_PORT || 3000);

const connectionString = process.env.DATABASE_URL
  || `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'devpassword'}@localhost:5433/${process.env.POSTGRES_DB || 'clinic'}`;
const pool = new pg.Pool({ connectionString, max: 4 });

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

const TOOLS = JSON.parse(await readFile(join(HERE, '../../prompts/actions.json'), 'utf8'));

const EMERGENCY = ['severe pain', 'bleeding', 'swelling', 'swollen', 'emergency',
  'knocked out', 'knocked-out', 'broken jaw', "can't breathe", 'cant breathe', 'can not breathe'];

// --- shared SQL (mirrors Workflow A "Build Context SQL") -------------------
function buildContextSql({ pnid, from, text, msgId }) {
  return `
with cl as (select id, name, timezone, google_calendar_id, staff_notify_number from clinics where phone_number_id = '${esc(pnid)}'),
pat as (insert into patients (clinic_id, whatsapp_number) select id, '${esc(from)}' from cl
  on conflict (clinic_id, whatsapp_number) do update set whatsapp_number = excluded.whatsapp_number returning id, clinic_id, is_returning),
con as (insert into conversations (clinic_id, patient_id, status, last_message_at) select pat.clinic_id, pat.id, 'bot', now() from pat
  on conflict (clinic_id, patient_id) do update set last_message_at = now() returning id, status),
prior as (select count(*)::int as prior_count from messages m join con on m.conversation_id = con.id),
ins as (insert into messages (clinic_id, conversation_id, role, content, wa_message_id) select pat.clinic_id, con.id, 'patient', '${esc(text)}', '${esc(msgId)}' from pat, con
  on conflict (wa_message_id) do nothing returning id),
recent as (select coalesce(json_agg(x order by x.created_at), '[]') as history from (
  select role, content, created_at from messages m join con on m.conversation_id = con.id order by created_at desc limit 10) x)
select cl.id as clinic_id, cl.name as clinic_name, cl.timezone, cl.google_calendar_id, cl.staff_notify_number,
  pat.id as patient_id, pat.is_returning, con.id as conversation_id, con.status,
  prior.prior_count, (select count(*)::int from ins) as inserted, recent.history
from cl, pat, con, prior, recent;`;
}

async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

async function ragSearch(clinicId, queryVec) {
  const lit = '[' + queryVec.join(',') + ']';
  const r = await pool.query(
    `select content, category, 1 - (embedding <=> $1::vector) as similarity
     from knowledge_base where clinic_id = $2 order by embedding <=> $1::vector limit 5`,
    [lit, clinicId],
  );
  return r.rows;
}

function buildSystem(ctx, kbRows) {
  const tz = ctx.timezone || 'UTC';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const clinic = ctx.clinic_name || 'the clinic';
  const kbBlock = kbRows.length
    ? '\n\n## Knowledge base (retrieved for this question)\n' + kbRows.map((r) => `- [${r.category}] ${r.content}`).join('\n')
    : '\n\n## Knowledge base\n(no relevant clinic facts retrieved for this message)';
  return `You are the receptionist assistant for ${clinic}, replying to patients on WhatsApp. You are not a general-purpose chatbot and not a medical professional.

## Grounding
- You have no clinic-specific facts unless they appear in a Knowledge base block below. Pricing, hours, services, staff, policies, insurance — state them only if present there. If absent or not covered, do not guess; say a team member will confirm.
- You may answer general health-education questions, but mark them clearly as general information — never advice tailored to this patient, never a diagnosis.

## Tone
- Warm, professional, concise. If the patient mentions pain or anxiety, acknowledge it briefly before logistics. Never argue with an upset patient — escalate.

## Actions
- To check availability, book, reschedule, cancel, or hand off to staff, call the provided tool. Don't claim an action is done until its result comes back. Only call book_appointment for a time the patient explicitly confirmed; call check_availability first.

## After an action runs
- Availability: write ONE short intro line only (e.g. "Here are the next available times:") — slot buttons are shown automatically, do NOT list times yourself.
- Booking: use exactly this format:
  ✅ Booked! [service] — [day date], [time][, with [provider] if known].
  We'll remind you the day before. Need to change it? Just message me.

## Conversation rule — always end with one next step
Every reply must close with exactly ONE offer, question, or call to action. Never a dead end.
- Price / hours / services → bridge to booking: "Want me to check available times?"
- Any info answer → offer the most helpful next action
- Don't know → "Want me to get a team member to answer this?"
Never include more than one closing question.

## Keep it short
2–3 lines max per message. One idea per bubble.

## Language
Reply in the same language the patient uses. Urdu → Urdu. Roman Urdu → Roman Urdu. English → English.${kbBlock}

## Patient context
Current date: ${today} (timezone ${tz}). is_returning: ${!!ctx.is_returning}.`;
}

// --- generation: Claude (Messages API) OR ChatGPT (Chat Completions) ------
// Both expose the same normalized turn: a text reply or a single tool call,
// plus llmPhrase() to turn a tool result into the final natural reply.
async function anthropicTurn(system, messages, tools) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(Object.assign({ model: MODEL, max_tokens: 700, system, messages }, tools ? { tools, tool_choice: { type: 'auto' } } : {})),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}
async function openaiTurn(messages, tools) {
  const oaTools = tools && tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(Object.assign({ model: OPENAI_CHAT_MODEL, max_tokens: 700, messages }, oaTools ? { tools: oaTools, tool_choice: 'auto' } : {})),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return res.json();
}

// history: [{role:'user'|'assistant', content}]. Returns {kind:'text',text} or
// {kind:'tool', id, name, input, ...thread} carrying what llmPhrase needs.
async function llmComplete({ system, history, userText, tools }) {
  if (PROVIDER === 'anthropic') {
    const messages = [...history, { role: 'user', content: userText }];
    const r = await anthropicTurn(system, messages, tools);
    const tu = (r.content || []).find((b) => b.type === 'tool_use');
    if (r.stop_reason === 'tool_use' && tu) return { kind: 'tool', id: tu.id, name: tu.name, input: tu.input || {}, _a: { messages, assistant: r.content } };
    const t = (r.content || []).find((b) => b.type === 'text');
    return { kind: 'text', text: (t && t.text) || '' };
  }
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];
  const r = await openaiTurn(messages, tools);
  const m = r.choices[0].message;
  if (m.tool_calls && m.tool_calls.length) {
    const tc = m.tool_calls[0];
    let input = {}; try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave {} */ }
    return { kind: 'tool', id: tc.id, name: tc.function.name, input, _o: { messages, assistant: m } };
  }
  return { kind: 'text', text: m.content || '' };
}
async function llmPhrase(prev, toolResult) {
  if (PROVIDER === 'anthropic') {
    const r = await anthropicTurn(
      'You are the clinic receptionist assistant. Phrase the tool result naturally and warmly for WhatsApp. For availability, list the options and ask the patient to pick one. Keep it concise.',
      [...prev._a.messages, { role: 'assistant', content: prev._a.assistant }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: prev.id, content: JSON.stringify(toolResult) }] }], null);
    const t = (r.content || []).find((b) => b.type === 'text');
    return (t && t.text) || 'Done — anything else?';
  }
  const r = await openaiTurn([...prev._o.messages, prev._o.assistant, { role: 'tool', tool_call_id: prev.id, content: JSON.stringify(toolResult) }], null);
  return r.choices[0].message.content || 'Done — anything else?';
}

// Format a slot timestamp into a short button-friendly label (≤20 chars for WhatsApp buttons).
function formatSlotLabel(scheduledAt, tz) {
  const d = new Date(scheduledAt);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz || 'UTC' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' });
  return `${day}, ${time}`.substring(0, 20);
}

// Simulated Google Calendar availability: clinic-hours slots on the target date.
function simSlots(ctx, input) {
  const tz = ctx.timezone || 'UTC';
  const date = input.date || new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  const windows = { morning: [9, 11], afternoon: [14, 16], evening: [17, 18], any: [10, 15] };
  const [a, b] = windows[input.time_preference] || windows.any;
  const slots = [];
  for (let h = a; h <= b && slots.length < 3; h++) {
    const scheduledAt = `${date}T${String(h).padStart(2, '0')}:00:00`;
    slots.push({ scheduled_at: scheduledAt, label: formatSlotLabel(scheduledAt, tz) });
  }
  return { date, slots, note: 'SIMULATED availability (no real Google Calendar in the test harness)' };
}

async function runAction(ctx, tool) {
  const input = tool.input || {};
  if (tool.name === 'escalate_to_human') {
    await pool.query("update conversations set status='human', status_changed_at=now() where id=$1", [ctx.conversation_id]);
    return { escalated: true, reason: input.reason || 'requested' };
  }
  if (tool.name === 'check_availability') return simSlots(ctx, input);
  if (tool.name === 'book_appointment') {
    const r = await pool.query(
      `insert into appointments (clinic_id, patient_id, service_type, scheduled_at, duration_minutes, status)
       values ($1,$2,$3,$4,30,'booked') returning id, scheduled_at`,
      [ctx.clinic_id, ctx.patient_id, input.service_type || 'appointment', input.scheduled_at],
    );
    return { booked: true, appointment_id: r.rows[0].id, scheduled_at: r.rows[0].scheduled_at, note: 'SIMULATED — DB row written, no real calendar event' };
  }
  if (tool.name === 'reschedule_appointment' || tool.name === 'cancel_appointment') {
    let apptId = input.appointment_id;
    if (!apptId) {
      const up = await pool.query(
        `select id from appointments where patient_id=$1 and status in ('booked','confirmed','rescheduled')
         and scheduled_at > now() order by scheduled_at limit 1`, [ctx.patient_id]);
      apptId = up.rows[0] && up.rows[0].id;
    }
    if (!apptId) return { error: 'no upcoming appointment found' };
    if (tool.name === 'cancel_appointment') {
      await pool.query("update appointments set status='cancelled' where id=$1", [apptId]);
      return { cancelled: true, appointment_id: apptId };
    }
    await pool.query("update appointments set scheduled_at=$1, status='rescheduled' where id=$2", [input.new_scheduled_at, apptId]);
    return { rescheduled: true, appointment_id: apptId, new_scheduled_at: input.new_scheduled_at };
  }
  return { error: 'unknown tool' };
}

// --- the pipeline (one patient message -> one bot reply) ------------------
async function handleMessage(from, text) {
  const debug = { keys: { anthropic: !!ANTHROPIC_KEY, openai: !!OPENAI_KEY }, steps: [] };
  const ctxRes = await pool.query(buildContextSql({ pnid: CLINIC_PHONE_ID, from, text, msgId: 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2) }));
  const ctx = ctxRes.rows[0];
  if (!ctx || !ctx.clinic_name) return { reply: '(no clinic matched this phone_number_id — check db/seed.sql)', debug };
  debug.route = 'bot';
  debug.first_message = Number(ctx.prior_count) === 0;

  const low = text.toLowerCase();
  const isEmergency = EMERGENCY.some((k) => low.includes(k));
  const disclosure = debug.first_message
    ? `Hi! You're chatting with ${ctx.clinic_name}'s automated assistant 🤖 — I can help with questions, appointments, and reminders. A team member is always available if you need one.`
    : '';

  const logBot = async (reply) => { await pool.query("insert into messages (clinic_id, conversation_id, role, content) values ($1,$2,'bot',$3)", [ctx.clinic_id, ctx.conversation_id, reply]); };

  if (ctx.status === 'human') {
    debug.route = 'human';
    debug.steps.push('conversation in human mode → staff notified, bot silent');
    return { reply: '(bot is silent — conversation is with staff. Reset to test the bot again.)', debug };
  }
  if (isEmergency) {
    debug.route = 'emergency';
    await pool.query("update conversations set status='human', status_changed_at=now() where id=$1", [ctx.conversation_id]);
    debug.steps.push('emergency keyword → flipped to human + staff alerted');
    const reply = "I'm sorry you're dealing with this. I've alerted our team and someone will reply here right away. If this is life-threatening, please call your local emergency number now.";
    await logBot(reply);
    return { reply: (disclosure ? disclosure + '\n\n' : '') + reply, debug };
  }

  // RAG
  let kbRows = [];
  if (OPENAI_KEY) {
    try { kbRows = await ragSearch(ctx.clinic_id, await embed(text)); debug.steps.push(`RAG: ${kbRows.length} chunk(s) retrieved`); }
    catch (e) { debug.steps.push('RAG error: ' + e.message); }
  } else debug.steps.push('RAG skipped (no OPENAI_API_KEY)');
  debug.rag = kbRows.map((r) => ({ category: r.category, similarity: Number(r.similarity).toFixed(3), content: r.content.slice(0, 80) }));

  if (!HAS_LLM) {
    const reply = `(no LLM key — reply stubbed. Triage=${debug.route}, RAG hits=${kbRows.length}. Set OPENAI_API_KEY (ChatGPT) or ANTHROPIC_API_KEY in .env for real answers.)`;
    return { reply: (disclosure ? disclosure + '\n\n' : '') + reply, debug };
  }
  debug.provider = `${PROVIDER} (${GEN_LABEL})`;

  const history = (ctx.history || []).map((m) => ({ role: m.role === 'patient' ? 'user' : 'assistant', content: m.content }));
  const first = await llmComplete({ system: buildSystem(ctx, kbRows), history, userText: text, tools: TOOLS });

  if (first.kind === 'tool') {
    debug.tool = { name: first.name, input: first.input };
    const result = await runAction(ctx, { name: first.name, input: first.input });
    debug.action_result = result;

    if (first.name === 'escalate_to_human') {
      const reply = "I'm connecting you with a team member now — they'll reply here shortly.";
      await logBot(reply);
      return { reply: (disclosure ? disclosure + '\n\n' : '') + reply, debug };
    }

    // Availability check: return slot buttons instead of prose
    if (first.name === 'check_availability' && result.slots && result.slots.length) {
      const intro = 'Here are the next available times — tap to pick one:';
      const buttons = result.slots.slice(0, 3).map((s) => s.label);
      const fullReply = disclosure ? disclosure + '\n\n' + intro : intro;
      await logBot(fullReply);
      return { reply: fullReply, buttons, debug };
    }

    const phrase = (await llmPhrase(first, result)) || 'Done — anything else?';
    // Booking confirmation: add a confirm/change button pair
    const buttons = first.name === 'book_appointment' && result.booked
      ? ['🔄 Reschedule', '❌ Cancel booking']
      : undefined;
    const reply = (disclosure ? disclosure + '\n\n' : '') + phrase;
    await logBot(reply);
    return { reply, buttons, debug };
  }

  const replyText = first.text || 'Sorry, could you say that another way?';
  // First message: append welcome menu buttons
  const welcomeButtons = disclosure ? ['📅 Book appointment', '💬 Ask a question', '👤 Talk to staff'] : undefined;
  const reply = (disclosure ? disclosure + '\n\n' : '') + replyText;
  await logBot(reply);
  return { reply, buttons: welcomeButtons, debug };
}

async function resetPatient(from) {
  await pool.query('delete from patients where clinic_id=(select id from clinics where phone_number_id=$1) and whatsapp_number=$2', [CLINIC_PHONE_ID, from]);
}

// --- HTTP server ----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = await readFile(join(HERE, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, provider: PROVIDER, gen_model: GEN_LABEL, has_llm: HAS_LLM, rag: !!OPENAI_KEY, clinic_phone_id: CLINIC_PHONE_ID }));
    }
    if (req.method === 'POST' && (req.url === '/api/message' || req.url === '/api/reset')) {
      let raw = '';
      for await (const c of req) raw += c;
      const { from = 'webtest', text = '' } = JSON.parse(raw || '{}');
      if (req.url === '/api/reset') { await resetPatient(from); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      const out = await handleMessage(from, text);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reply: 'Server error: ' + (e.message || e), debug: { error: String(e.message || e) } }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Clinic bot tester → http://localhost:${PORT}`);
  console.log(`  DB:        ${connectionString.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`  Generation: ${HAS_LLM ? PROVIDER + ' (' + GEN_LABEL + ')' : 'NO LLM KEY (replies stubbed)'}`);
  console.log(`  RAG:        ${OPENAI_KEY ? 'OpenAI (' + EMBED_MODEL + ')' : 'NO OPENAI KEY (RAG skipped)'}\n`);
});
