-- Demo appointments for exercising reminders (Workflow B) and reschedule/cancel.
-- Re-runnable: clears the demo patient's appointments first, then inserts two
-- upcoming ones — 24h out and 2h out — so both reminder windows fire on the
-- next sweep. Times are relative to now(), so they stay valid whenever you run it.
--   psql "$DATABASE_URL" -f db/seed-appointments.sql   (or: npm run seed-appts)

with cl as (select id from clinics where phone_number_id = '1114486611757569'),
pat as (
  insert into patients (clinic_id, whatsapp_number, name, is_returning)
  select id, '923009999999', 'Demo Patient', true from cl
  on conflict (clinic_id, whatsapp_number) do update set name = excluded.name
  returning id, clinic_id
),
wipe as (
  delete from appointments a using pat where a.patient_id = pat.id
)
insert into appointments (clinic_id, patient_id, service_type, scheduled_at, duration_minutes, status)
select pat.clinic_id, pat.id, x.svc, now() + x.offs, 30, 'booked'
from pat, (values
  ('cleaning',     interval '24 hours'),
  ('consultation', interval '2 hours')
) as x(svc, offs)
returning service_type, scheduled_at, status;
