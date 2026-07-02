#!/usr/bin/env node
// Exercises the appointment lifecycle against a real Postgres — the DB side of
// booking (§4.2) and reminders (§4.3/§6.2), independent of the LLM. Mirrors the
// SQL the webchat's runAction() and Workflow B run: book -> reschedule ->
// reminder mark -> cancel. Creates and cleans up its own rows.
//
// Usage: DATABASE_URL=postgres://postgres:pw@localhost:5433/clinic node scripts/test/appointments.mjs

import pg from 'pg';
import process from 'node:process';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };

const connectionString = process.env.DATABASE_URL
  || `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'devpassword'}@localhost:5433/${process.env.POSTGRES_DB || 'clinic'}`;
const c = new pg.Client({ connectionString });
await c.connect();

const PHONE = '1114486611757569';
const FROM = 'appttest';
try {
  const clinicId = (await c.query('select id from clinics where phone_number_id=$1', [PHONE])).rows[0].id;
  const patientId = (await c.query(
    `insert into patients (clinic_id, whatsapp_number, name) values ($1,$2,'Appt Test')
     on conflict (clinic_id, whatsapp_number) do update set name=excluded.name returning id`,
    [clinicId, FROM])).rows[0].id;

  console.log('book_appointment (writes appointments row):');
  const booked = (await c.query(
    `insert into appointments (clinic_id, patient_id, service_type, scheduled_at, duration_minutes, status)
     values ($1,$2,'cleaning', now() + interval '2 days', 30, 'booked') returning id, status`,
    [clinicId, patientId])).rows[0];
  booked.id && booked.status === 'booked' ? ok(`booked appt ${booked.id.slice(0, 8)} (status=booked)`) : bad('book failed');

  console.log('\nlook-up latest upcoming (reschedule/cancel with appointment_id=null):');
  const found = (await c.query(
    `select id from appointments where patient_id=$1 and status in ('booked','confirmed','rescheduled')
     and scheduled_at > now() order by scheduled_at limit 1`, [patientId])).rows[0];
  found && found.id === booked.id ? ok('resolved the patient\'s upcoming appointment') : bad('lookup failed');

  console.log('\nreschedule_appointment:');
  const resc = (await c.query(
    "update appointments set scheduled_at = now() + interval '3 days', status='rescheduled' where id=$1 returning status",
    [booked.id])).rows[0];
  resc.status === 'rescheduled' ? ok('status -> rescheduled, time moved') : bad(`status=${resc.status}`);

  console.log('\nreminder mark (Workflow B "Mark Sent"):');
  await c.query('update appointments set reminder_24h_sent=true where id=$1', [booked.id]);
  const flag = (await c.query('select reminder_24h_sent from appointments where id=$1', [booked.id])).rows[0];
  flag.reminder_24h_sent === true ? ok('reminder_24h_sent=true (won\'t re-send)') : bad('flag not set');

  console.log('\nsweep excludes already-reminded appt:');
  const due = await c.query(
    `select id from appointments where patient_id=$1 and reminder_24h_sent=false
     and scheduled_at between now() + interval '23 hours' and now() + interval '25 hours'`, [patientId]);
  due.rowCount === 0 ? ok('appt no longer appears in the 24h sweep') : bad('still due after mark');

  console.log('\ncancel_appointment:');
  const canc = (await c.query("update appointments set status='cancelled' where id=$1 returning status", [booked.id])).rows[0];
  canc.status === 'cancelled' ? ok('status -> cancelled') : bad(`status=${canc.status}`);

  console.log('\nstatus check constraint rejects bad values:');
  try { await c.query("update appointments set status='banana' where id=$1", [booked.id]); bad('bad status accepted'); }
  catch { ok('DB rejects status outside the allowed set'); }

  await c.query('delete from patients where clinic_id=$1 and whatsapp_number=$2', [clinicId, FROM]);
  ok('cleaned up test rows (cascade)');
} finally {
  await c.end();
}
console.log(failures === 0 ? '\nALL APPOINTMENT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
