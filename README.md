# WhatsApp Clinic Receptionist Bot

MVP build of the spec in `whatsapp doc.docx`.
Stack: WhatsApp Cloud API · n8n · Claude/GPT · Postgres + pgvector · Google Calendar.

## Build progress (MVP — Spec §4)
- [x] Database schema (§5) — `db/schema.sql`, live in the `db` container
- [x] FAQ / RAG retrieval (§4.1) — `knowledge_base` + `match_knowledge_base()`, wired into Workflow A; loader in `scripts/load-knowledge-base.mjs`
- [x] Booking + Google Calendar (§4.2) — `check_availability` / `book` / `reschedule` / `cancel` tool dispatch in Workflow A *(logic + SQL verified; end-to-end run in n8n pending — see Verification status)*
- [x] Automated reminders (§4.3) — `n8n/workflow-b-reminders.json` + template `whatsapp/templates/appointment_reminder.json`
- [x] Human handoff (§4.4) — status → `human`, staff notification, bot stays silent
- [x] Bot disclosure (§4.5) — first-message disclosure in Workflow A's Triage node
- [x] Emergency keyword detection (§4.6) — keyword match → flip to `human` → urgent staff alert + patient ack

### Verification status
The **database layer is verified against a real Postgres 16 + pgvector**: run
`npm test`. `scripts/test/validate.mjs` checks every JSON file, compiles each n8n
Code-node, and validates the tool schemas; `scripts/test/sql.mjs` exercises the
find-or-create + message-dedupe + RAG match + reminder-sweep SQL live. The n8n
workflows themselves are **not yet run end-to-end** — that needs the n8n
container (see *Local dev stack*) plus the API credentials in §Credentials.

**LLM:** Claude `claude-haiku-4-5` for generation via the Anthropic Messages API,
OpenAI `text-embedding-3-small` for RAG embeddings (matches `vector(1536)`).
Both keys/models live in `.env` (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`,
`OPENAI_API_KEY`/`EMBEDDING_MODEL`) and are set in the n8n Credentials UI.

## Local dev stack (Docker)
```bash
cp .env.example .env          # an n8n encryption key + DB password are already set in .env
docker compose up -d n8n db adminer
```
| Service | URL | Notes |
|---------|-----|-------|
| n8n | http://localhost:5678 | Workflow editor — create the owner account on first visit |
| Postgres + pgvector | localhost:**5433** | DB `clinic`, user `postgres` (5433 because 5432 is used by another local DB) |
| Adminer | http://localhost:8080 | DB dashboard — System: PostgreSQL, Server: `db`, DB: `clinic` |
| ngrok | http://localhost:4040 | Public tunnel for Meta webhooks — needs `NGROK_AUTHTOKEN`, then `docker compose up -d ngrok` |

`db/schema.sql` auto-applies on first boot. For production, point the Postgres
credentials at a Supabase cloud connection string — n8n's Postgres node is unchanged.

## Working assumptions (Spec §12 open questions)
- **LLM:** Claude `claude-haiku-4-5` for generation (Anthropic Messages API) +
  OpenAI `text-embedding-3-small` embeddings (1536-dim). Anthropic has no
  embeddings endpoint, so OpenAI covers RAG vectors only. Models are set in
  `.env` (`ANTHROPIC_MODEL`, `EMBEDDING_MODEL`) and swappable there; the schema's
  `vector(1536)` already matches the embedding model.
- **One calendar / provider per clinic** for the MVP.

## Repo layout
| Path | What |
|------|------|
| `db/` | `schema.sql` (§5) and `seed.sql` (one test clinic) |
| `n8n/workflow-a-inbound.json` | Inbound message handling (§6.1): webhook → RAG → Claude tool-calling → booking/handoff/reply |
| `n8n/workflow-b-reminders.json` | Hourly reminder sweep (§6.2/§4.3) |
| `prompts/` | `system-prompt.md` (§7), `actions.json` (Claude tool schemas), `knowledge-base.sample.md` (KB seed data) |
| `whatsapp/templates/` | Pre-approval message templates for business-initiated reminders (§8) |
| `scripts/load-knowledge-base.mjs` | Embeds KB chunks → `knowledge_base` (§4.1/§10) |
| `scripts/test/` | `validate.mjs` (offline) + `sql.mjs` (live DB). `npm test` runs both. |

Import the two workflow JSONs into n8n (Workflows → Import from file), attach the
Postgres / Anthropic / OpenAI / WhatsApp / Google Calendar credentials, then
activate them.

## Try it without WhatsApp — local chat tester
A browser chat UI that runs the **same inbound pipeline** (find-or-create,
triage, emergency, disclosure, RAG, Claude tool-calling, booking) against the
local Postgres — no Meta, ngrok, or n8n needed. Google Calendar is *simulated*
(appointments are written to the DB), which is the only difference from prod.

```bash
docker compose up -d db            # or any Postgres+pgvector on :5433
cp .env.example .env               # add an LLM key (see below) for real replies
npm install
npm run webchat                    # → http://localhost:3000
```

**LLM provider:** generation works with **either** an OpenAI (ChatGPT) key **or**
an Anthropic key — `LLM_PROVIDER=auto` uses Claude if `ANTHROPIC_API_KEY` is set,
otherwise ChatGPT (`OPENAI_CHAT_MODEL`, default `gpt-4o-mini`). RAG embeddings
always use OpenAI, so **one OpenAI key covers both** generation and RAG. Set
`OPENAI_API_KEY` in `.env` and you're done.

Open the page, type as if you were a patient. The right panel shows the live
pipeline: route (bot/emergency/human), RAG hits with similarity, and any tool
call + result. **Reset conversation** clears the test patient so the first-time
disclosure fires again. Without keys the DB/triage/emergency/disclosure flow
still works and the panel tells you which keys are missing.

Quick messages to try: *"What are your opening hours?"* (RAG), *"Can I book
Tuesday afternoon?"* (booking tool), *"I have severe pain and swelling"*
(emergency), *"Can I speak to a person?"* (handoff).

## Credentials
Setup steps for the LLM key, Google Calendar OAuth, and WhatsApp Cloud API are in
[docs/credentials-setup.md](docs/credentials-setup.md).
