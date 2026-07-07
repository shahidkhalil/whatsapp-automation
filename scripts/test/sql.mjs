#!/usr/bin/env node
// Exercises the workflows' SQL against a real Postgres+pgvector, mirroring what
// the n8n Postgres nodes run. Proves: find-or-create patient/conversation,
// message write, webhook-retry de-dupe, RAG match, and the reminder sweep.
//
// Usage: DATABASE_URL=postgres://postgres:pw@localhost:5433/clinic node scripts/test/sql.mjs

import pg from 'pg';
import process from 'node:process';

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };

function buildContextSql(p) {
  const pnid = esc(p.phone_number_id), from = esc(p.from), text = esc(p.text), msgId = esc(p.msgId);
  return `
with cl as (select id, name, timezone, google_calendar_id, staff_notify_number from clinics where phone_number_id = '${pnid}'),
pat as (insert into patients (clinic_id, whatsapp_number) select id, '${from}' from cl
  on conflict (clinic_id, whatsapp_number) do update set whatsapp_number = excluded.whatsapp_number returning id, clinic_id, is_returning),
con as (insert into conversations (clinic_id, patient_id, status, last_message_at) select pat.clinic_id, pat.id, 'bot', now() from pat
  on conflict (clinic_id, patient_id) do update set last_message_at = now() returning id, status),
prior as (select count(*)::int as prior_count from messages m join con on m.conversation_id = con.id),
ins as (insert into messages (clinic_id, conversation_id, role, content, wa_message_id) select pat.clinic_id, con.id, 'patient', '${text}', '${msgId}' from pat, con
  on conflict (wa_message_id) do nothing returning id),
recent as (select coalesce(json_agg(x order by x.created_at), '[]') as history from (
  select role, content, created_at from messages m join con on m.conversation_id = con.id order by created_at desc limit 10) x)
select cl.name as clinic_name, cl.timezone, cl.staff_notify_number,
  pat.id as patient_id, pat.is_returning, con.id as conversation_id, con.status,
  prior.prior_count, (select count(*)::int from ins) as inserted, recent.history
from cl, pat, con, prior, recent;`;
}

const connectionString = process.env.DATABASE_URL
  || `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'devpassword'}@localhost:5433/${process.env.POSTGRES_DB || 'clinic'}`;
const client = new pg.Client({ connectionString });
await client.connect();

try {
  const PHONE = '1114486611757569'; // matches db/seed.sql
  const FROM = '923001234567';
  const MSG1 = 'test-msg-' + Date.now();

  console.log('Build Context SQL (first message):');
  let r = (await client.query(buildContextSql({ phone_number_id: PHONE, from: FROM, text: 'What are your opening hours?', msgId: MSG1 }))).rows[0];
  r && r.clinic_name ? ok(`resolved clinic "${r.clinic_name}"`) : bad('clinic not resolved');
  Number(r.inserted) === 1 ? ok('inbound message inserted (inserted=1)') : bad(`inserted=${r.inserted}`);
  Number(r.prior_count) === 0 ? ok('prior_count=0 -> first message (disclosure fires)') : bad(`prior_count=${r.prior_count}`);
  r.patient_id && r.conversation_id ? ok('patient + conversation created') : bad('missing ids');

  console.log('\nWebhook-retry de-dupe (same wa_message_id):');
  r = (await client.query(buildContextSql({ phone_number_id: PHONE, from: FROM, text: 'What are your opening hours?', msgId: MSG1 }))).rows[0];
  Number(r.inserted) === 0 ? ok('duplicate suppressed (inserted=0 -> Triage stops)') : bad(`inserted=${r.inserted} on retry`);
  Number(r.prior_count) === 1 ? ok('prior_count=1 (second turn, no disclosure)') : bad(`prior_count=${r.prior_count}`);

  console.log('\nUnknown phone_number_id (not our clinic):');
  r = (await client.query(buildContextSql({ phone_number_id: 'NOPE', from: FROM, text: 'hi', msgId: 'x' + Date.now() }))).rows[0];
  (!r || !r.clinic_name) ? ok('no clinic row -> Triage returns [] and stops') : bad('unexpectedly resolved a clinic');

  console.log('\nRAG match_knowledge_base (needs embeddings loaded):');
  const kb = await client.query('select count(*)::int n from knowledge_base');
  if (kb.rows[0].n === 0) {
    console.log('  • knowledge_base empty — run scripts/load-knowledge-base.mjs (needs OPENAI_API_KEY). Skipping match test.');
  } else {
    const dim = (await client.query('select vector_dims(embedding) d from knowledge_base where embedding is not null limit 1')).rows[0];
    dim && dim.d === 1536 ? ok('stored embeddings are 1536-dim') : bad(`embedding dim ${dim && dim.d}`);
    const probe = '[' + Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',') + ']';
    const clinicId = (await client.query("select id from clinics where phone_number_id=$1", [PHONE])).rows[0].id;
    const m = await client.query(`select content, category, similarity from match_knowledge_base('${probe}'::vector, '${clinicId}'::uuid, 3)`);
    m.rowCount > 0 ? ok(`match_knowledge_base returned ${m.rowCount} rows`) : bad('match returned 0 rows');
  }

  console.log('\nReminder sweep query (Workflow B):');
  const rem = await client.query(`
    select a.id from appointments a
    join patients p on p.id=a.patient_id join clinics c on c.id=a.clinic_id
    where a.status in ('booked','confirmed','rescheduled') and a.reminder_24h_sent=false
      and a.scheduled_at between now() + interval '23 hours' and now() + interval '25 hours'`);
  ok(`24h sweep executed (${rem.rowCount} due now — expected 0 with no appointments)`);

  console.log('\nCleanup test rows:');
  await client.query("delete from patients where whatsapp_number = $1", [FROM]);
  ok('removed test patient (cascades to conversation + messages)');
} finally {
  await client.end();
}

console.log(failures === 0 ? '\nALL SQL CHECKS PASSED' : `\n${failures} SQL CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
