# WhatsApp Clinic Receptionist Bot

MVP build of the spec in `whatsapp doc.docx`.
Stack: WhatsApp Cloud API · n8n · Claude/GPT · Postgres + pgvector · Google Calendar.

## Build progress (MVP — Spec §4)
- [x] Database schema (§5) — `db/schema.sql`, live in the `db` container
- [ ] Booking + Google Calendar (§4.2) — highest risk, built first
- [ ] FAQ / RAG retrieval (§4.1)
- [ ] Automated reminders (§4.3)
- [ ] Human handoff (§4.4)
- [ ] Bot disclosure (§4.5)
- [ ] Emergency keyword detection (§4.6)

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
- **LLM:** OpenAI `gpt-4o-mini` (chat) + `text-embedding-3-small` embeddings (1536-dim) —
  one key covers both. Models are set in `.env` (`OPENAI_MODEL`, `EMBEDDING_MODEL`) and
  swappable there. The schema's `vector(1536)` already matches the embedding model.
- **One calendar / provider per clinic** for the MVP.

## Credentials
Setup steps for the LLM key, Google Calendar OAuth, and WhatsApp Cloud API are in
[docs/credentials-setup.md](docs/credentials-setup.md).
