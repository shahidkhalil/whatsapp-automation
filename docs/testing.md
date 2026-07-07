# Testing guide

How to run and test the clinic bot, from "no accounts at all" up to a live
WhatsApp number. Three levels — pick how far you want to go.

| Level | Needs | Tests |
|-------|-------|-------|
| 1. Automated DB tests | Postgres only | schema, dedupe, RAG match, booking, reminders |
| 2. Local chat tester | Postgres + 1 LLM key | full conversation (RAG, Claude/ChatGPT, booking, handoff) — no WhatsApp |
| 3. Full n8n stack | Docker + all credentials | the real WhatsApp path end to end |

---

## Prerequisites

- **Node 18+** and **npm** (`npm install` once).
- **Postgres 16 + pgvector on `:5433`**, database `clinic`. Easiest:
  `docker compose up -d db` (uses `POSTGRES_PASSWORD` from `.env`). Any other
  Postgres+pgvector works — set `DATABASE_URL` to point at it.
- Copy env: `cp .env.example .env` and fill values as each level needs.

`db/schema.sql` auto-applies on the `db` container's first boot; `db/seed.sql`
adds one test clinic (`phone_number_id = 1114486611757569`).

---

## Level 1 — automated tests (no LLM, no WhatsApp)

```bash
export DATABASE_URL="postgres://postgres:devpassword@localhost:5433/clinic"
npm test
```

Runs three suites:
- `test/validate.mjs` — every JSON parses, all n8n Code-nodes compile, tool
  schemas are valid, the KB loader parses chunks. **No DB or keys needed.**
- `test/sql.mjs` — against the live DB: find-or-create patient/conversation,
  message write, **webhook-retry de-dupe**, unknown-clinic stop, RAG match
  (if the KB is loaded), reminder sweep.
- `test/appointments.mjs` — booking lifecycle: book → look-up → reschedule →
  reminder-mark → sweep-excludes → cancel → constraint check. Creates and
  cleans up its own rows.

Run individually with `npm run test:offline` / `test:sql` / `test:appts`.

---

## Level 2 — local chat tester (the easy way to see it work)

A browser chat UI that runs the **same inbound pipeline** as
`n8n/workflow-a-inbound.json` against your local Postgres. No Meta, ngrok, or
n8n. Google Calendar is *simulated* (bookings write a real `appointments` row,
no calendar event) — the only difference from production.

**1. Add an LLM key to `.env`.** Either works:
- OpenAI / ChatGPT only (one key covers generation **and** RAG embeddings):
  ```
  OPENAI_API_KEY=sk-...
  ```
- or Claude for generation (still needs OpenAI for embeddings):
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  OPENAI_API_KEY=sk-...
  ```
`LLM_PROVIDER=auto` uses Claude if its key is set, otherwise ChatGPT.

**2. Load the knowledge base** so RAG has facts to ground on:
```bash
npm run load-kb -- --file prompts/knowledge-base.sample.md \
    --clinic-phone-id 1114486611757569 --replace
```

**3. (Optional) seed demo appointments** so reschedule/cancel have something to act on:
```bash
npm run seed-appts
```

**4. Start it:**
```bash
npm run webchat        # → http://localhost:3000
```
The header shows the active provider (e.g. `openai · gpt-4o-mini · RAG ✓`). The
right-hand panel shows the live pipeline: route, RAG hits with similarity, and
any tool call + result. **Reset conversation** clears the test patient so the
first-message disclosure fires again.

### What to type to test each feature

| Try | Exercises | Expect |
|-----|-----------|--------|
| *(any first message)* | Bot disclosure (§4.5) | reply is prefixed with the "automated assistant" disclosure once |
| `What are your opening hours?` | RAG (§4.1) | grounded answer from the KB; panel shows an `[hours]` hit. Without the KB loaded it says "let me have a colleague confirm" (correct grounding) |
| `How much is a cleaning?` | RAG (§4.1) | quotes the seeded price |
| `Can I book something Tuesday afternoon?` | Booking (§4.2) | `check_availability` tool → 2–4 slots offered |
| `Yes, 2pm works` | Booking (§4.2) | `book_appointment` → confirmation; a row appears in `appointments` |
| `I need to move my appointment to Thursday` | Reschedule (§4.2) | `reschedule_appointment` → time moved |
| `Cancel my appointment` | Cancel (§4.2) | `cancel_appointment` → status cancelled |
| `Can I speak to a person?` | Handoff (§4.4) | `escalate_to_human`; conversation flips to human |
| `I have severe pain and swelling` | Emergency (§4.6) | routes to **emergency** → staff alerted + reassuring ack; bot then silent |

> Note: the tester can't send a real WhatsApp reminder (that needs Meta). Use
> Level 1's `test:appts` / the sweep query to verify reminder logic.

---

## Level 3 — full n8n stack (real WhatsApp)

1. **Start services:** `docker compose up -d n8n db adminer`
   (n8n at `localhost:5678`, Adminer at `localhost:8080`).
2. **Fill all credentials in `.env`** and in n8n's Credentials UI — see
   [credentials-setup.md](credentials-setup.md): Anthropic **or** OpenAI (LLM),
   OpenAI (embeddings), WhatsApp Cloud API, Google Calendar OAuth.
3. **Import both workflows** (n8n → Workflows → Import from file):
   `n8n/workflow-a-inbound.json` and `n8n/workflow-b-reminders.json`. Attach the
   Postgres / LLM / WhatsApp / Google Calendar credentials to the matching
   nodes, then **Activate** both.
4. **Load the KB** (`npm run load-kb …` as above).
5. **Expose the webhook:** `docker compose up -d ngrok`, copy the
   `https://…ngrok…` URL into Meta → WhatsApp → Configuration → Callback URL
   `…/webhook/whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN`, subscribe
   to **messages**. Set the clinic's real `phone_number_id` in the `clinics` row.
6. **Submit the reminder template** `whatsapp/templates/appointment_reminder.json`
   for approval in Meta (business-initiated messages need a pre-approved
   template; approval can take time — do this early).
7. **Text the number** from your verified WhatsApp and walk the table above.

---

## Known environment limits (cloud dev sandboxes)

If you're running this inside a restricted cloud environment rather than your
own machine, two things may be blocked by network/policy — both work locally:

- **`api.openai.com` / `api.anthropic.com` egress** — LLM and embedding calls
  fail (e.g. `403 Host not in allowlist`). Levels 1 (DB) still pass; Level 2
  generation/RAG needs reachable LLM hosts.
- **Docker image pulls** (`n8nio/n8n`, `pgvector/pgvector`) — may 403 at the
  registry CDN, blocking the `db`/`n8n` containers. Substitute any local
  Postgres 16 + pgvector and point `DATABASE_URL` at it.
