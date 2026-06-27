# Credentials Setup

The three external services the booking workflow needs. Each is tied to **your**
accounts. Work top to bottom — none depends on another.

| Credential | Goes where | Cost |
|-----------|-----------|------|
| Anthropic API key (Claude) | n8n credential UI + `.env` (for scripts) | pay-per-use |
| OpenAI API key (embeddings) | n8n credential UI + `.env` | pay-per-use, tiny |
| Google Calendar OAuth client | n8n credential UI | free |
| WhatsApp Cloud API token | n8n credential UI + `.env` | free tier |

> n8n stores workflow credentials in its own encrypted store — you paste keys
> into the n8n **Credentials** UI, not `.env`. The `.env` copies exist only for
> standalone scripts (e.g. the knowledge-base embedding loader in a later step).

---

## 1. LLM + embeddings keys

### Anthropic (Claude — generation)
1. Go to **console.anthropic.com** and sign in.
2. **Settings → API keys → Create key**. Name it `clinic-bot`. Copy it now (shown once).
3. **Settings → Billing** → add a payment method or buy credits.
4. Model: **`claude-haiku-4-5`** — $1 / $5 per 1M input/output tokens, the cheapest
   capable Claude. It supports strict structured outputs, which the action JSON in
   `prompts/system-prompt.md` relies on.
5. Put in `.env`: `ANTHROPIC_API_KEY=...` and `ANTHROPIC_MODEL=claude-haiku-4-5`.

### OpenAI (embeddings only)
Anthropic doesn't offer an embeddings endpoint. We use OpenAI for the RAG vectors.
1. Go to **platform.openai.com** → sign in → **API keys → Create new secret key**. Copy it.
2. **Settings → Billing** → add a payment method (embeddings are ~$0.02 per 1M tokens — cents).
3. Model: **`text-embedding-3-small`** (1536 dimensions — matches `vector(1536)` in
   `db/schema.sql`). *Alternative:* Voyage AI (`voyage-3.5`), Anthropic's recommended
   partner — but its dimensions differ, so you'd change the schema and re-embed.
4. Put in `.env`: `OPENAI_API_KEY=...`.

In n8n later: add an **Anthropic** credential and an **OpenAI** credential (paste the
same keys), used by the LLM and embeddings nodes.

---

## 2. Google Calendar OAuth (self-hosted n8n)

Self-hosted n8n needs its own Google OAuth client.

1. **console.cloud.google.com** → create a project (e.g. `clinic-bot`).
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → **External** → fill app name + your
   email → under **Test users**, add your own Google account (keeps it in Testing mode,
   no Google verification needed for dev).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   **Application type: Web application**.
5. **Authorized redirect URI:** open n8n → **Credentials → New → Google Calendar OAuth2 API**;
   n8n shows its exact **OAuth Redirect URL** — copy it back into Google. Locally it's
   usually `http://localhost:5678/rest/oauth2-credential/callback` (if you point n8n's
   editor base at the ngrok URL, use that host instead — use whatever n8n displays).
6. Copy the **Client ID** and **Client secret** into the n8n credential → **Sign in with
   Google** → authorize.
7. **Calendar ID:** Google Calendar (web) → the calendar's **Settings → Integrate
   calendar → Calendar ID** (often your email, or `primary`). Put it in the clinic row:
   update `clinics.google_calendar_id` (currently `primary` in `db/seed.sql`).

---

## 3. WhatsApp Cloud API (Meta)

1. **developers.facebook.com** → log in → **My Apps → Create App** → use case **Other** →
   type **Business** → name it.
2. In the app: **Add product → WhatsApp → Set up**. This provisions a free **test phone
   number**, a temporary **access token** (24h), a **Phone number ID**, and a WhatsApp
   Business Account ID.
3. **API Setup** → add your own WhatsApp number as a **recipient** (verify via the code Meta texts you).
4. Copy into `.env`:
   - `WHATSAPP_PHONE_NUMBER_ID=` ← the Phone number ID
   - `WHATSAPP_TOKEN=` ← the access token
   - `WHATSAPP_VERIFY_TOKEN=` ← any random string you make up (used in the next step)
5. **Webhook** (WhatsApp → **Configuration**):
   - **Callback URL** = your ngrok HTTPS URL + the n8n webhook path, e.g.
     `https://<your-ngrok>.ngrok-free.app/webhook/whatsapp`
   - **Verify token** = the same random string you put in `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
6. Update the clinic row so inbound routing (§3.1) resolves: set
   `clinics.phone_number_id` to the real Phone number ID (replace `TEST_PHONE_NUMBER_ID`).

**Two gotchas (from §8):**
- The 24h token expires. For stable dev, create a **System User** token in **Business
  Settings → Users → System users** with `whatsapp_business_messaging` +
  `whatsapp_business_management` permissions — that token is long-lived.
- The 24-hour session window: free-form replies only work within 24h of the patient's
  last message. Reminders (outside that window) need **pre-approved templates** — we
  submit those when we build §4.3.

---

## After setup
Tell me when the keys exist and I'll wire the booking workflow's nodes to them and run
an end-to-end test. You don't need all three to start — the LLM key alone lets us test
intent → action parsing.
