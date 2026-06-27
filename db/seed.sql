-- Test clinic for local development.
-- phone_number_id is a placeholder until the real Meta WhatsApp number is
-- registered (§8) — update it then so inbound routing (3.1) resolves correctly.
insert into clinics (name, phone_number_id, timezone, staff_notify_number, google_calendar_id)
values ('Test Dental Clinic', '1114486611757569', 'Asia/Karachi', '+10000000000', 'primary')
on conflict (phone_number_id) do nothing;
