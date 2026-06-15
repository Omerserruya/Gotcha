# GOTCHA Support Handbook

Audience: customer success / support engineers. This is a single file you can
Ctrl-F through when a customer reports an issue. Every section ends with a
**"Where to look"** pointer so you can reproduce the issue in the admin UI
or in logs.

---

## 1. Product Orientation (5 minutes)

GOTCHA is a **multi-channel conversation platform** that unifies inbound
messages from WhatsApp, Gmail, Outlook, Messenger, Instagram, Slack, and
webchat into a single inbox, with an AI employee layer that can handle
conversations autonomously, assist human agents, or run bot workflows.

The product is organised around **tenants** (customer accounts). Every
object - conversations, contacts, messages, AI agents, integrations,
knowledge bases - is scoped to a tenant and never crosses that boundary.

### The main surfaces a customer will ask about

| Surface | URL | What it does |
|---|---|---|
| **Conversations** | `/conversations` | Shared inbox for all channels |
| **History** | `/history` | Closed / archived conversations |
| **AI Studio** | `/ai-studio` | Configure AI agents, tools, knowledge, flows |
| **Integrations** | `/integrations` | Connect third-party apps (Zoho, HubSpot, Shopify, …) |
| **Knowledge** | `/ai-studio/knowledge` | Upload docs / connect Confluence / Google Drive |
| **Agents** | `/ai-studio/agents` | AI employee profiles |
| **Flows** | `/ai-studio/flows` | Visual chatbot flow builder |
| **Broadcasts** | `/broadcasts` | Outbound campaigns |
| **Approvals** | In-inbox banner | Human-in-the-loop gate for risky actions |
| **Settings** | `/settings` | Team, channels, billing |

### Who can do what

| Role | Can |
|---|---|
| **ADMIN** | Everything: connect channels, configure AI, invite users, billing |
| **AGENT** | Reply in inbox, claim/close conversations, use copilot |
| **SUPERVISOR** | Agent + approve HITL actions, view team analytics |

Most "I can't see X" tickets are a role problem. Confirm role first.

---

## 2. Core Concepts Glossary

- **Channel** - a connected inbound source (WhatsApp number, Gmail mailbox, etc.). Stored as `ChannelAccount`. Each channel has its own credentials, webhook, and routing.
- **Contact** - a person who has messaged in. One contact can own multiple channel identifiers (email + phone + IG handle) via the identity layer.
- **Conversation** - a thread between one contact and the brand on one channel. Status: `OPEN`, `CLOSED`, `PAUSED`.
- **Router Rule** - decides which department / AI agent handles a new conversation based on channel, keyword, or condition.
- **AI Agent (AI Employee)** - a configured LLM persona (`AIAgent` table): name, role, tone, system prompt, knowledge bases, tools. Runs in one of two modes:
  - **Autonomous (bot)** - replies automatically to customer messages.
  - **Assist (copilot)** - drafts replies for a human agent to send.
- **Integration** - a connection to a third-party system (Zoho CRM, Shopify, HubSpot, …). Listed in `IntegrationCatalog`; connected per-tenant via `TenantIntegration`; individual tools enabled via `TenantTool`.
- **Tool** - a function the AI can call. Two kinds:
  - **Internal**: `send_message`, `tag_contact`, `create_broadcast`, `escalate_to_human`, etc.
  - **Integration (external)**: `integration_create_lead`, `integration_contact_search`, etc. - per-tenant based on which integrations are connected.
- **Agent Tool Permission** - per-AI-agent allowlist of which tools THIS agent can use (on top of the tenant-wide toggle).
- **Knowledge Base** - a set of documents the AI can search (RAG). Backed by Qdrant vector DB.
- **Approval Request** - a HITL gate. When an AI tries to run a risky action, the conversation is paused until a supervisor approves.
- **Broadcast** - scheduled outbound campaign to a contact segment.

---

## 3. Channel Setup & Troubleshooting

### 3.1 WhatsApp (Meta Business API)

**Connection flow:** Settings → Channels → Add WhatsApp → opens Meta Embedded
Signup → select/approve WhatsApp Business Account → returns with access token
stored in `ChannelAccount.credentials`.

**Common issues:**

| Symptom | Likely cause | Fix |
|---|---|---|
| "No phone number appears after Embedded Signup" | Tenant's Meta BM doesn't own a verified phone number | Customer must verify phone in Meta Business Manager first |
| Incoming messages not showing up | Webhook URL not subscribed in Meta | Go to Meta dev portal → WhatsApp → Configuration → verify webhook URL matches `PUBLIC_URL/api/webhook` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches env |
| Outbound fails with `#131056` | 24-hour session window expired | Agent must use an approved **template** (HSM) to re-open the conversation |
| Outbound fails with `#10` or `#33` | Wrong `phone_number_id` | Check `ChannelAccount.externalId` against Meta console; may need to disconnect + reconnect |
| Status stays `PENDING` after signup | Token exchange did not complete | Check auth-service logs for `[WA-Signup]`; usually a `CHANNEL_ENCRYPTION_KEY` misconfiguration - tokens couldn't be encrypted and saved |

**Where to look:**
- `services/auth` logs (tagged `[WA-Signup]`, `[OAuth]`)
- `ChannelAccount` table - look for `status = "ERROR"` and `lastError` field
- `services/webhook` logs for incoming message events

### 3.2 Gmail / Outlook (OAuth)

**Connection flow:** Settings → Channels → Connect Gmail/Outlook → Google/MS
consent screen → stores token in `ChannelAccount.credentials` + subscribes to
push notifications (Gmail) or webhook subscription (Outlook).

**Common issues:**

| Symptom | Cause | Fix |
|---|---|---|
| OAuth redirect fails with "invalid redirect URI" | Redirect URI in Google/MS app console doesn't match env var | Match `GOOGLE_OAUTH_REDIRECT_URI` / `MICROSOFT_OAUTH_REDIRECT_URI` exactly (including protocol, no trailing slash) |
| Token expires after ~1 hour | Refresh token missing | Customer revoked consent; disconnect + reconnect; make sure `access_type=offline` was used |
| Emails not syncing | Watch expired (Gmail) or subscription expired (Outlook) | Background worker re-subscribes on schedule; if stuck, disconnect + reconnect |
| Sent emails appear as replies from wrong address | `From` header not overridden | Known limitation - emails go out as the connected mailbox address |

### 3.3 Messenger / Instagram

Both use Meta Embedded Signup. Same class of issues as WhatsApp.

Special case: **Instagram DMs require a Business/Creator account** connected to
a Facebook Page that's linked to a Meta Business Manager. If any of those
links is missing, Embedded Signup will show no available IG accounts.

### 3.4 Slack

Connection flow: Settings → Channels → Slack → standard OAuth. Stores bot
token in `ChannelAccount.credentials`. Uses `SLACK_SIGNING_SECRET` to verify
incoming webhook events.

**Common issue:** Slack only delivers DMs to the bot if it's in the
workspace AND the user is on the paid plan. Free-tier Slack has known
limits.

### 3.5 Voice Co-Pilot (Twilio)

Live transcription + AI coaching during phone calls. Requires:

- Twilio account + Voice API enabled
- A purchased E.164 number (Twilio Console → Phone Numbers)
- An API Key + Secret (Twilio Console → API Keys, type **Standard**)
- A TwiML App pointing its Voice Request URL at `PUBLIC_BASE_URL/api/voice-copilot/twiml/outbound` (POST)
- `STT_PROVIDER=google` or `deepgram` for real transcription (default `stub` is dev-only)

**Common ticket:** "Voice calls don't show transcripts." - 90% of the time it's `STT_PROVIDER=stub` still set in `.env`.

---

## 4. AI Agents (Bot + Copilot)

### 4.1 Modes

- **Autonomous (bot)** - the AI replies to customers directly. Runs in
  `services/incoming-worker`.
- **Assist (copilot)** - the AI drafts suggestions shown in the inbox side
  panel; a human agent decides what to send.

A single `AIAgent` can be configured for either or both. Mode is decided by
the routing rule + the agent's `autonomousEnabled` flag.

### 4.2 Agent Configuration

In **AI Studio → Agents → [select agent]** the customer can set:

- **Name / Role / Description** - shapes the system prompt
- **Tone** (comma-separated: professional, friendly, concise, …)
- **Style flags** - emoji, first-name, proactive, concise
- **Knowledge Bases** - which RAG sources the agent can query
- **Tools** - which integration tools this agent is allowed to call
- **Escalation Rules** - conditions that auto-hand off to a human

### 4.3 Prompt Assembly

The final system prompt is assembled from:
1. Agent name, role, description, tone
2. Behavioral rules from style flags
3. Tool descriptions
4. Escalation rules (autonomous mode only)
5. Custom guardrails

If a customer complains "the bot says X I didn't tell it to say", the
likely source is their own **description** or **style** settings, not
hidden platform behaviour. Open the agent's config and read the
description carefully - the LLM will faithfully produce whatever polite
closing phrase is suggested there.

### 4.4 Bot Tool Surface

For the **autonomous bot** to call an integration tool, THREE things must be true:

1. Tenant has the integration **CONNECTED** (`TenantIntegration.status = "CONNECTED"`)
2. The specific tool is **enabled** at tenant level (`TenantTool.isEnabled = true`) - check: AI Studio → Integrations → [integration] → tool toggles
3. The specific **AI agent** is allowed to use it (`AgentToolPermission.isAllowed = true`) - check: AI Studio → Agents → [agent] → Tools section

Missing #3 is the single most common cause of "the bot doesn't do anything". Connected tools at the tenant level DO NOT automatically appear for every agent.

### 4.5 Escalation Behaviour

Bot auto-escalates when:

- Customer explicitly asks for a human ("נציג", "human agent", "speak to someone", etc.)
- Conversation has reached `maxAutonomousMessages` (default 10)
- The AI emits `escalate_to_human` tool call (confidence-based)
- A tool action triggers DENY from the policy gate

On escalation: conversation status flips to `PAUSED`, a notification fires
to the department's human agents, and the AI stops replying.

### 4.6 Common AI Issues

| Symptom | Fix |
|---|---|
| "The bot replies but doesn't use my tools" | Check AgentToolPermission rows (section 4.4) |
| "The bot immediately escalates every time" | Check `maxAutonomousMinutes` - known issue where conversation age exceeds budget |
| "Replies are in the wrong language" | Agent prompt says "always respond in customer's language" - likely the customer's first message was ambiguous; tune tone/description |
| "Bot mentions product features we don't have" | Hallucination - customer needs better knowledge base coverage or tighter system prompt |
| "Bot's response is cut off mid-sentence" | Raise `maxTokens` in agent config |
| "Bot always ends with 'let me know if you have more questions'" | Disable **Proactive** style flag OR add guardrail: "Do not add trailing sign-offs" |

**Where to look:**
- `services/incoming-worker` logs tagged `[AI-Bot]`
- `services/ai` logs tagged `[AI-Assist]`
- `AuditLog` table rows where `action LIKE 'ai.tool_call.%'`
- `AIUsage` table for token burn

---

## 5. Knowledge Base (RAG)

### 5.1 Supported Sources

- Direct upload (PDF, DOCX, MD, TXT)
- Confluence (OAuth)
- Google Drive (OAuth)
- URL scraping

Documents are chunked → embedded with OpenAI `text-embedding-3-small` →
stored in Qdrant. Retrieved at query time via cosine similarity (top 5).

### 5.2 Common Issues

| Symptom | Fix |
|---|---|
| "I uploaded a doc but AI doesn't know about it" | Check `KnowledgeDocument.status` - should be `ready`, not `processing` or `error`. If stuck, look at embedding-service logs |
| "Confluence sync imports 0 pages" | Space permissions - the connecting user must have READ access to the space |
| "Google Drive sync hits quota" | 403 from Drive API - customer needs to wait or reduce sync batch |
| "RAG retrieves irrelevant chunks" | Chunk size too coarse (`RAG_CHUNK_SIZE` default 500) - lower to 300 or re-upload with clearer structure |
| Document stuck in `processing` | Embedding-service OpenAI call failed - check `services/ai` logs for `[Embedding]` errors |

**Where to look:**
- `services/ai` logs tagged `[Embedding]`, `[KB]`, `[Confluence]`, `[GDrive]`
- Qdrant web UI at `http://{host}:6333/dashboard` (internal access only)
- `KnowledgeDocument`, `KnowledgeChunk` tables

---

## 6. Integrations Marketplace (Zoho, HubSpot, Shopify, …)

### 6.1 Connection Flow

1. Customer opens AI Studio → Integrations → [integration].
2. For **OAUTH2** integrations (Zoho, Salesforce, Google Calendar, Slack, Square): click "Connect with OAuth" → provider consent screen → auto-return with `?connected=<slug>`.
3. For **API_KEY** integrations (HubSpot, Shopify, Zendesk, …): paste API key into form → click Connect → then Test.
4. Once `TenantIntegration.status = "CONNECTED"`, tools appear and can be toggled on/off.

### 6.2 OAuth Provider Checklist

For each OAuth provider, the customer must have:
- An app registered in the provider's developer console
- A matching **Redirect URI** registered there
- The **exact same** redirect URI configured in GOTCHA's `.env`
- The correct **data-center / region** selected (critical for Zoho CRM)

### 6.3 Zoho CRM Specifics

- Data centers: `.com` (US), `.eu`, `.in`, `.com.au`, `.jp`. `ZOHO_ACCOUNTS_URL` must match the customer's account region.
- Redirect URI: `{PUBLIC_URL}/api/integrations/oauth/zoho_crm/callback`
- Scopes requested: `ZohoCRM.modules.contacts.ALL, leads.ALL, deals.ALL, users.READ`
- Zoho writes require `{"data":[{...}]}` body wrapper - the catalog input schema documents this.

### 6.4 Common Integration Issues

| Symptom | Fix |
|---|---|
| "OAuth init returns 500 - Zoho OAuth not configured" | `ZOHO_CLIENT_ID / SECRET / REDIRECT_URI` env vars are empty - set them |
| "Invalid redirect URI" at consent screen | Provider console doesn't have the exact URI you use locally |
| "Integration is CONNECTED but tool returns 401" | Token expired + refresh failed - disconnect + reconnect |
| "Tool returns `no endpoint configured`" | Catalog row has NULL endpoint - engineering needs to ship a migration (e.g. the Zoho tool-endpoints migration) |
| "Lead created in wrong Zoho region" | `config.baseUrl` on `TenantIntegration` points at wrong domain - disconnect + reconnect to fetch the correct `api_domain` |

**Where to look:**
- `TenantIntegration.lastError` for the most recent failure message
- `ToolExecution` table for raw HTTP output
- `services/ai` logs tagged `[ToolExec]`, `[Zoho OAuth]`, etc.

---

## 7. Approvals (Human-in-the-Loop)

When the AI tries a high-risk tool (refund, large discount, irreversible
external action) the policy gate creates an `ApprovalRequest` and pauses the
conversation. Supervisors see an in-inbox banner with approve / reject
buttons.

### Common tickets

- "My bot is frozen, not replying" - check if there's a pending approval. Conversation pauses until resolved.
- "I can't see the approval button" - user role is `AGENT`, not `SUPERVISOR`.
- "Approved but action didn't run" - check `ApprovalRequest.status` - should flip `PENDING → APPROVED → EXECUTED`. If stuck at `APPROVED`, the executor bound to it failed. Look at `ai-agents` / `tool-execution` logs.

**Where to look:**
- `ApprovalRequest` table
- `AuditLog` rows with `action LIKE 'approval.%'`

---

## 8. Broadcasts / Campaigns

Customers create a broadcast in `/broadcasts` → pick audience (segment by
tag, channel, last-interaction) → pick a WhatsApp template → schedule.

### Common issues

| Symptom | Fix |
|---|---|
| "Template is rejected by WhatsApp" | Template must be pre-approved in Meta console. GOTCHA only picks from already-approved ones. |
| "Only some recipients got the message" | Check `BroadcastDelivery` rows for per-recipient status. Common: opt-outs, invalid numbers, 24-hour window (template re-opens it), or rate-limit backoff. |
| "Broadcast scheduled but never fired" | `services/outgoing-worker` not healthy - check logs for `[scheduled-worker]` |

---

## 9. Billing & AI Usage

- Every AI call (bot reply, copilot suggestion, KB embedding, onboarding chat) is logged in `AIUsage` with token counts + estimated cost.
- Surfaced in **Settings → Usage** for the customer.
- Models used: `gpt-4o-mini` by default (set via `OPENAI_DEFAULT_MODEL`).
- Pricing constants are in `packages/shared/src/lib/ai-usage.ts` - `AI_MODEL_PRICING`.

### Common question
"Why was I charged $X this month?" - pull `AIUsage` rows, group by feature
(ai_bot, copilot, embedding, onboarding), show token breakdown.

---

## 10. Common User Playbooks (Runbook)

### "My inbox is empty but customers say they sent messages"
1. Check channel status in Settings → Channels. Anything in `ERROR`?
2. Check webhook verify in the channel provider's console.
3. Check `services/webhook` logs for recent `[WEBHOOK]` lines - are events arriving?
4. If webhook is arriving but no conversation is created, check `RouterRule` - a misconfigured rule can drop messages.

### "The AI bot stopped replying to a specific conversation"
1. Check `Conversation.status` - if `PAUSED`, there's either an approval pending or a human claimed it.
2. Check for recent escalation: `AuditLog` where `action = 'ai.escalate'`.
3. Check `AIAgent.autonomousEnabled` - was it toggled off?
4. Check AI usage for that tenant - could be a soft cap.

### "I connected an integration but the AI doesn't use it"
1. Is the integration `CONNECTED` (green badge on the integration page)?
2. Is the specific tool **enabled** (toggle at the bottom of the integration page)?
3. Does the AI agent have permission for that tool (AI Studio → Agents → Tools)?
4. Is the tool the **type** of action the AI would naturally take from the conversation? Prompt tuning may be needed.

### "Customer got bot replies in English but sent messages in Hebrew"
Default rule in the shared prompt says "Always respond in the same
language the customer is using." If the bot's first message was in English
(greeting card), the model may anchor to that. Fix:
- Disable the canned greeting
- Add custom guardrail: "Detect the language from the LATEST customer message and reply in that language."

### "Voice calls aren't being recorded / transcribed"
1. `STT_PROVIDER` env - must be `google` or `deepgram`, not `stub`.
2. `DEEPGRAM_API_KEY` or Google service-account JSON present?
3. Twilio TwiML App has correct Voice Request URL?
4. Check `services/voice-copilot` logs tagged `[VoiceSession]`.

---

## 11. Escalation Paths to Engineering

Escalate to engineering when:

- Any **500 error loop** from the gateway on a single endpoint for more than 5 minutes
- Any **TenantGuard** error in logs (indicates a missing `tenantId` on a Prisma query - likely data leak risk)
- Postgres or Redis health failing (check `db` / `redis` container health)
- Qdrant returning errors on KB search
- OpenAI 429 rate-limit errors affecting multiple tenants
- Any `[AI-Bot]` log line with `OpenAI error: 400` mentioning schema validation
- Customer requests a hard delete of all their data (GDPR - runbook needs approval)

Always include in the escalation:
- **Tenant ID** (`SELECT id FROM tenants WHERE slug = '...'`)
- **Conversation ID** or **User ID** if scoped
- **Timestamp window** (±15 minutes around the incident)
- **What the customer was trying to do**
- **What they saw** (screenshot if possible)
- Relevant log snippets with tags (e.g. `[AI-Bot]`, `[WA-Signup]`, `[ToolExec]`)

---

## 12. Useful Queries & Tools

### Find the tenant from a user email
```sql
SELECT t.id, t.name, t.slug
FROM tenants t
JOIN users u ON u.tenant_id = t.id
WHERE u.email = '<user_email>';
```

### Find a conversation by external id (WhatsApp wamid, Gmail message id, …)
```sql
SELECT c.id, c.status, c.created_at
FROM conversations c
JOIN messages m ON m.conversation_id = c.id
WHERE m.external_id = '<wamid...>';
```

### Pull the last N messages on a conversation
```sql
SELECT direction, channel, body, created_at
FROM messages
WHERE conversation_id = '<conv_id>'
ORDER BY created_at DESC
LIMIT 20;
```

### Check which integrations a tenant has connected
```sql
SELECT ic.slug, ti.status, ti.connected_at, ti.last_error
FROM tenant_integrations ti
JOIN integration_catalog ic ON ic.id = ti.integration_id
WHERE ti.tenant_id = '<tenant_id>';
```

### Check which tools an AI agent is allowed to use
```sql
SELECT ct.slug, ct.name, atp.is_allowed, atp.require_approval
FROM agent_tool_permissions atp
JOIN tenant_tools tt ON tt.id = atp.tenant_tool_id
JOIN catalog_tools ct ON ct.id = tt.catalog_tool_id
WHERE atp.ai_agent_id = '<ai_agent_id>';
```

### Tail AI service logs for a given tenant
```bash
docker compose logs -f ai | grep '<tenant_id>'
```

### Tail bot activity for a conversation
```bash
docker compose logs -f incoming-worker | grep '<conversation_id>'
```

---

## 13. Known Limitations (as of 2026-04-22)

- **F1 - Contact merges**: hard-deletes the source row; next message from
  merged channel can resurrect a new contact. Work in progress - ask
  engineering before doing a merge for a customer.
- **F4 - Approval surface**: HITL banner is fully wired only in the bot
  engine. Command Center plans currently don't surface approvals inline.
- **F5 - Copilot sidebar**: 21 AI-assist endpoints exist but only 3 are
  wired into the current UI. If customer asks about advanced copilot
  features, many are backend-only for now.
- **F6 - Follow-ups**: Scheduled follow-up templates are hardcoded; the
  smart LLM-generated follow-up is wired but not yet on the default path.
- **Outlook `From` override**: Not supported - emails go out as the
  connected mailbox.
- **Free-tier Slack**: DMs limited.
- **Single-tenant per user**: A user account maps to exactly one tenant.
  Agency-style "manage multiple customers from one login" is not yet supported.

---

## 14. Internal Glossary (Engineering Speak)

Useful if a ticket quotes a log line.

| Term | Meaning |
|---|---|
| `TenantGuard` | Prisma middleware that blocks queries without a `tenantId` filter |
| `withCrossTenantAccess` | Explicit escape hatch for cross-tenant reads |
| `RouterRule` | Row that decides which dept/AI handles a new conversation |
| `ChannelAccount` | Per-tenant credentials for one inbound channel |
| `ToolExecution` | Audit record of one integration API call |
| `AIAgent.sharedPrompt` / `autonomousPrompt` | Pre-generated prompt fragments, regenerated on agent save |
| `ApprovalRequest` | Paused state waiting for human OK |
| `AgentToolPermission` | Per-AI-agent allowlist for tools |
| `ai.tool_call.<name>` (audit action) | LLM invoked a specific tool |
| `ai.escalate` (audit action) | Bot handed off to human |

---

*Last updated: 2026-04-22.* If this handbook is wrong or out of date,
open a PR to `docs/support/support-handbook.md` - it's source-controlled.
