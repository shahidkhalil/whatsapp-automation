-- WhatsApp Clinic Receptionist Bot — Database Schema (Supabase / Postgres)
-- Spec Section 5. Apply by pasting into the Supabase SQL editor (or psql).
-- Multi-tenant: every clinic-scoped table carries clinic_id (Spec Section 3).

-- Extensions
create extension if not exists vector;     -- pgvector, for RAG embeddings (5.5)
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- 5.1 clinics ---------------------------------------------------------------
create table clinics (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone_number_id     text not null unique,  -- Meta-assigned; inbound routing key (3.1)
  timezone            text not null,         -- IANA, e.g. Asia/Karachi
  staff_notify_number text,                  -- alerted on handoff / emergency
  google_calendar_id  text,                  -- default booking calendar
  created_at          timestamptz not null default now()
);

-- 5.2 patients --------------------------------------------------------------
create table patients (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references clinics(id) on delete cascade,
  whatsapp_number text not null,
  name            text,
  is_returning    boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (clinic_id, whatsapp_number)        -- one patient row per number per clinic
);

-- 5.3 conversations ---------------------------------------------------------
create table conversations (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references clinics(id) on delete cascade,
  patient_id        uuid not null references patients(id) on delete cascade,
  status            text not null default 'bot' check (status in ('bot','human')),
  status_changed_at timestamptz not null default now(), -- human-mode auto-revert timer (4.4)
  last_message_at   timestamptz not null default now(), -- 24h session-window check (8)
  unique (clinic_id, patient_id)                        -- one conversation row per patient (find-or-create)
);

-- messages — conversation history ------------------------------------------
-- Not in Section 5's table list, but required by 6.1 (step 5, "write to
-- conversation history") and 7.2 (per-turn input needs recent history).
-- wa_message_id de-dupes Meta's webhook retries so a redelivered inbound
-- message is never processed — or replied to — twice.
create table messages (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references clinics(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('patient','bot','staff','system')),
  content         text,
  wa_message_id   text unique,
  created_at      timestamptz not null default now()
);

-- 5.4 appointments ----------------------------------------------------------
create table appointments (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references clinics(id) on delete cascade,
  patient_id        uuid not null references patients(id) on delete cascade,
  provider_name     text,                    -- null = any available provider
  service_type      text,                    -- determines slot duration
  scheduled_at      timestamptz not null,
  duration_minutes  integer not null,
  google_event_id   text,                    -- calendar event ref for updates/cancellation
  status            text not null default 'booked'
                    check (status in ('booked','confirmed','rescheduled','cancelled','completed','no_show')),
  reminder_24h_sent boolean not null default false,
  reminder_2h_sent  boolean not null default false,
  created_at        timestamptz not null default now()
);

-- 5.5 knowledge_base (RAG) --------------------------------------------------
-- embedding dimension 1536 = OpenAI text-embedding-3-small (Open Question #1,
-- defaulted per 13.3). If you switch embedding models, change the dimension
-- here AND re-embed before loading data.
create table knowledge_base (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  content    text not null,
  embedding  vector(1536),
  category   text check (category in ('services','pricing','hours','doctors','policies','faq','insurance')),
  updated_at timestamptz not null default now()
);

-- Indexes -------------------------------------------------------------------
create index on patients (clinic_id, whatsapp_number);          -- find-or-create (6.1)
create index on conversations (clinic_id, patient_id);
create index on messages (conversation_id, created_at desc);    -- recent history (7.2)
-- Reminder sweep (6.2): scan only appointments still in play.
create index on appointments (scheduled_at)
  where status in ('booked','confirmed','rescheduled');
create index on knowledge_base (clinic_id);
create index on knowledge_base using hnsw (embedding vector_cosine_ops);

-- RAG retrieval: top-k similar chunks, scoped to one clinic (3.1 / 6.1).
create or replace function match_knowledge_base(
  query_embedding vector(1536),
  p_clinic_id     uuid,
  match_count     int default 5
)
returns table (id uuid, content text, category text, similarity float)
language sql stable
as $$
  select kb.id, kb.content, kb.category,
         1 - (kb.embedding <=> query_embedding) as similarity
  from knowledge_base kb
  where kb.clinic_id = p_clinic_id
  order by kb.embedding <=> query_embedding
  limit match_count;
$$;

-- Row Level Security: patient PII lives here. n8n connects with the Supabase
-- service_role key, which bypasses RLS; enabling RLS with no policy denies the
-- public anon key by default. Keep all access server-side.
alter table clinics        enable row level security;
alter table patients       enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table appointments   enable row level security;
alter table knowledge_base enable row level security;
