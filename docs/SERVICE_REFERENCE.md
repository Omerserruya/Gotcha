# ChatCenter - Service Reference Guide

Detailed API reference and business logic for every service.

---

## 1. Auth Service (`services/auth` - Port 4001)

### 1.1 Authentication Routes (`/api/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/me` | Bearer (Authentik) | Get current authenticated user + department info |

There are no register/login/reset endpoints: sign-in happens at Authentik (OIDC Authorization Code + PKCE in the browser). Services verify the resulting RS256 access token against Authentik's JWKS (`packages/shared/src/lib/jwt.ts`, no signing path) and resolve `sub` to `User.authentikSubject` via `resolvePrincipal`.

**Sign-in Logic (Authentik):**
1. Browser is redirected to Authentik and authenticates there (password, MFA, recovery all Authentik-owned)
2. The callback exchanges the code for tokens; every API call carries the Authentik access token
3. `authenticate()` middleware verifies the token via JWKS, string-matches `iss` against `OIDC_ISSUER`, and loads the local user by `authentikSubject`
4. If ADMIN + tenant status=PENDING_ADMIN_SETUP, first authenticated request transitions the tenant to PENDING_ONBOARDING
5. Sign JWT, return `{token, user, tenantStatus}`

---

### 1.2 Onboarding Routes (`/api/onboarding`)

All routes require JWT + ADMIN role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Onboarding progress (currentStep, profile status, dept count) |
| GET | `/business-profile` | Retrieve saved business profile |
| POST | `/business-profile` | Save business profile (advances step to DEPARTMENTS) |
| GET | `/departments` | Get configured departments |
| POST | `/departments` | Configure departments (advances step to COMPLETED) |
| POST | `/ai-chat` | Onboarding LLM chat for AI fine-tuning |
| POST | `/generate-configs` | Generate agent configs for all departments |
| POST | `/complete` | Activate tenant (validates + generates configs + ACTIVE) |
| GET | `/agent-config/:departmentId` | View generated agent config |

**Onboarding Step Flow:**
```
BUSINESS_PROFILE -> DEPARTMENTS -> AI_CONFIG -> COMPLETED
```

**AI Chat System:**
- Uses OpenAI GPT-4o-mini with structured JSON responses
- 4 sequential questions: communication tone, escalation policy, customer topics, restrictions
- Supports English & Hebrew locales
- Auto-readyToGenerate after 3 exchanges or user says "skip"
- Fallback Q&A engine when no OpenAI key

**Complete Onboarding Validates:**
- Business profile exists
- At least 1 department configured
- SLA targets set on all departments
- Admin user is active
- Generates all agent configs (if not done)
- Creates tenant-level CopilotConfig defaults
- Transitions tenant to ACTIVE
- Sends activation confirmation email

---

### 1.3 System Admin Routes (`/api/system`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/login` | None | System admin login (SYSTEM_ADMIN role) |
| POST | `/seed` | None | Create first SYSTEM_ADMIN (requires setupSecret) |
| GET | `/stats` | SYSTEM_ADMIN | System-wide stats |
| GET | `/tenants` | SYSTEM_ADMIN | List tenants (paginated, searchable) |
| GET | `/tenants/:id` | SYSTEM_ADMIN | Tenant detail + users + channels |
| POST | `/tenants` | SYSTEM_ADMIN | Create tenant + admin + onboarding tracker |
| PATCH | `/tenants/:id` | SYSTEM_ADMIN | Update tenant (name, isActive) |
| DELETE | `/tenants/:id` | SYSTEM_ADMIN | Delete tenant (cascade, force option) |
| POST | `/tenants/:id/users` | SYSTEM_ADMIN | Create user in tenant |
| PATCH | `/tenants/:id/users/:userId` | SYSTEM_ADMIN | Update user (active, role) |
| POST | `/tenants/:id/resend-onboarding` | SYSTEM_ADMIN | Resend onboarding email |
| PATCH | `/tenants/:id/first-take-care` | SYSTEM_ADMIN | Enable/disable First-Take-Care |

**Tenant Creation Flow:**
1. Provision the admin's identity in Authentik (`ensureIdentity`)
2. Create Tenant (status=PENDING_ADMIN_SETUP) + ADMIN user linked via `authentikSubject` (no password stored)
3. Initialize TenantOnboarding (step=BUSINESS_PROFILE)
4. Publish `tenant:created` event
5. Send onboarding email with an Authentik setup link (non-blocking); the admin chooses their password there

---

### 1.4 Agents Routes (`/api/agents`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Any | List agents with dept membership + active convo count |
| POST | `/` | ADMIN | Create agent |
| PATCH | `/:id` | ADMIN | Update agent |

**Settings sub-routes (`/api/agents/settings/`):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/PUT | `/auto-greeting` | Auto-greeting template (Redis) |
| GET/POST/PATCH/DELETE | `/channels`, `/channels/:id` | Channel account CRUD |
| GET/PUT | `/channel-config` | Bot flow mode (UNIFIED/PER_CHANNEL) |
| GET/PUT | `/business-hours` | Business hours schedule (Redis) |
| GET/PUT | `/sla` | Tenant SLA settings |
| GET/PUT | `/sla/department/:deptId` | Department SLA override |
| GET/PUT | `/idle-automation` | Idle reminder/auto-close (Redis) |
| GET/PUT | `/copilot` | Tenant copilot config |
| GET/PUT | `/first-take-care` | First-Take-Care AI settings |

---

### 1.5 Department Routes (`/api/departments`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Any | List departments |
| POST | `/` | ADMIN | Create department |
| PATCH | `/:id` | ADMIN | Update department |
| DELETE | `/:id` | ADMIN | Delete department |
| GET | `/:id/members` | MANAGER+ | List members |
| POST | `/:id/members` | ADMIN | Add member |
| PATCH | `/:id/members/:userId` | ADMIN | Update member role |
| DELETE | `/:id/members/:userId` | ADMIN | Remove member |
| GET | `/:id/copilot` | MANAGER+ | Get dept copilot (falls back to tenant) |
| PUT | `/:id/copilot` | MANAGER+ | Update dept copilot |

---

### 1.6 Channel Routes (`/api/channels`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | ADMIN | List connected channels with status |
| GET | `/oauth/init` | Token query | Generate OAuth URL |
| GET | `/oauth/callback` | None | Meta OAuth callback |
| POST | `/connect/whatsapp` | ADMIN | WhatsApp Embedded Signup |
| POST | `/connect/whatsapp-session` | ADMIN | Complete WA popup session |
| POST | `/:id/disconnect` | ADMIN | Soft disconnect channel |
| GET | `/:id/status` | ADMIN | Health check channel token |
| GET | `/config` | ADMIN | OAuth configuration status |

---

## 2. Conversation Service (`services/conversation` - Port 4002)

### 2.1 Conversation Routes (`/api/conversations`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Any | List conversations (filtered, paginated) |
| GET | `/:id` | Any | Get conversation with messages |
| POST | `/:id/claim` | Any | Claim unassigned conversation |
| POST | `/:id/release` | Any | Release conversation to queue |
| POST | `/:id/reassign` | Any | Transfer to agent or department |
| POST | `/:id/close` | Any | Close conversation (async AI summary) |
| DELETE | `/:id` | ADMIN | Delete conversation (must be CLOSED or force=true) |
| GET | `/history/:phone` | Any | Customer conversation history |
| GET | `/stats/workload` | ADMIN | Agent workload distribution |

**Conversation Scoping:**
- ADMIN: all conversations
- AGENT: own department + unassigned + assigned to them

**Query Filters:** status, assignedAgentId, channel, departmentId, search (phone/name)

**Conversation State Machine:**
```
OPEN (initial / assigned / released)
  |
  +--> WAITING (transferred to dept without agent)
  |
  +--> CLOSED (via close endpoint)
```

### 2.2 Message Routes

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/:id/messages` | Any | List messages (paginated, max 100) |
| POST | `/:id/messages` | Any | Send outbound message |
| DELETE | `/:id/messages/:msgId` | ADMIN | Delete message |

**Send Message Flow:**
1. Validate conversation + channel configured
2. Decrypt channel credentials
3. Create message (OUTBOUND, PENDING)
4. Queue to outgoing worker (3 retries, exponential backoff)
5. Emit `message:new` event

**Message Status Progression:**
```
PENDING -> SENT -> DELIVERED -> READ
                              -> FAILED (any time)
```
Only forward progression allowed (no regression).

### 2.3 WebSocket (Socket.IO)

**Connection:** JWT token in `socket.handshake.auth.token`
**Rooms:** `tenant:{tenantId}`, `user:{userId}`

**Events Emitted:**
| Event | Trigger | Payload |
|-------|---------|---------|
| `conversation:updated` | Claim, reassign, release, transfer | Conversation object |
| `conversation:closed` | Close conversation | Conversation object |
| `message:new` | Message created | `{message, conversationId}` |
| `message:status` | Delivery status change | `{messageId, conversationId, status}` |

---

## 3. AI Service (`services/ai` - Port 4006)

### 3.1 Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/ai-assist/config` | Tenant copilot configuration |
| GET | `/api/ai-assist/:id/suggestions` | 2-3 reply suggestions (JSON mode) |
| GET | `/api/ai-assist/:id/summary` | 2-3 sentence summary |
| GET | `/api/ai-assist/prompt/:deptId` | Debug: assembled system prompt |

### 3.2 Config Resolution Priority

```
1. DepartmentCopilotConfig.systemPrompt (if non-empty) -> use as-is
2. DepartmentCopilotConfig structured blocks -> assemble at runtime
3. AgentConfig blocks -> assemble (backward compatibility)
4. TenantCopilotConfig -> fallback defaults
```

### 3.3 Assembled Prompt Structure

```
[Core Engine Instructions]

## Identity
- Role, Responsibility, Guidelines

## Goals
- Focus, SLA, Objective, Quality Expectations

## Communication Tone
- Formality, Empathy, Assertiveness, Brand Alignment

## Behavioral Rules
- Escalation Triggers, Forbidden Actions, Safety, Confidence Handling

## Operating Mode: [COPILOT|AUTONOMOUS|HYBRID]
- Mode-specific rules

## Available Tools
- Allowed/Restricted tools

## Current Context (injected at runtime)
- Customer name, conversation history
```

### 3.4 OpenAI API Calls

| Task | Temperature | Max Tokens | Format |
|------|------------|------------|--------|
| Suggestions | 0.7 (config) | 1024 (config) | JSON object |
| Summary | 0.3 | 256 | Plain text |
| Intent Classification | 0.0 | 128 | JSON object |

---

## 4. Incoming Worker (`services/incoming-worker`)

### 4.1 Workers

| Worker | Trigger | Concurrency |
|--------|---------|------------|
| Incoming Message | Queue: `incoming-messages` | 3 |
| Channel Health | Cron: every 6h (check), 12h (refresh) | 1 |
| Idle Conversation | Cron: every 5 min | 1 |

### 4.2 Message Processing Pipeline

1. **Validate** tenant is ACTIVE
2. **Deduplicate** by externalMessageId
3. **Profile lookup** from Meta API (name, avatar)
4. **Find/create** conversation (by channel + customerExternalId + non-CLOSED)
5. **Create message** (INBOUND, DELIVERED)
6. **Update** conversation.lastMessageAt
7. **Publish** events: message:new, conversation:updated
8. **Analytics** queue: message_received
9. **Chatbot** flow (if no agent, not handed over)

### 4.3 Chatbot Engine

**Node Types:**
| Type | Behavior |
|------|----------|
| start | Entry point |
| message | Send text, continue to next |
| quick_reply | Send buttons, pause for input |
| condition | Route based on input match |
| department_route | Check hours, round-robin assign |
| handover | Transfer to human queue |
| end | Close conversation |

**Safeguards:** Max 20 execution steps per flow run.

### 4.4 Channel Health

| Check | Schedule | Action |
|-------|----------|--------|
| Token validity | Every 6h | Call Meta debug_token, update status |
| Token refresh | Every 12h | Exchange for long-lived token (Messenger/IG) |

### 4.5 Idle Automation

| Action | Condition | Effect |
|--------|-----------|--------|
| Reminder | idle >= reminderDelayMinutes | Send reminder, update reminderSentAt |
| Auto-close | idle >= autoCloseDelayMinutes | Send close msg, CLOSED status, system msg |

---

## 5. Webhook Service (`services/webhook` - Port 4003)

### 5.1 Webhook Processing

1. Receive POST from Meta platform
2. Detect platform (WhatsApp/Messenger/Instagram) via adapter
3. Verify HMAC SHA256 signature
4. Resolve tenant from ChannelAccount lookup
5. Normalize messages to `NormalizedInboundMessage`
6. Enqueue `IncomingMessageJob` to Redis queue
7. Handle status updates (delivered/read) inline
8. Return 200 immediately

### 5.2 Webhook Verification

- GET endpoint for Meta webhook verification challenge
- Validates `hub.verify_token` matches configured token
- Returns `hub.challenge` on success

---

## 6. Outgoing Worker (`services/outgoing-worker`)

### 6.1 Message Delivery

1. Consume `OutgoingMessageJob` from queue
2. Select channel adapter (WhatsApp/Messenger/Instagram)
3. Call Meta Graph API
4. Update message status (SENT or FAILED)
5. Publish `message:status` event

### 6.2 Retry Policy

- 3 attempts maximum
- Exponential backoff (1s initial delay)
- Final failure marks message as FAILED

---

## 7. Frontend (`frontend` - Port 3000)

### 7.1 Page Routes

**Tenant Pages (AppLayout):**
| Route | Role | Description |
|-------|------|-------------|
| `/conversations` | All | Main conversation interface |
| `/history` | ADMIN/MANAGER | Chat history viewer |
| `/dashboard` | ADMIN | Analytics dashboard |
| `/chatbot` | ADMIN | Chatbot flow builder |
| `/channels` | ADMIN | Channel connections |
| `/departments` | ADMIN | Department management |
| `/agents` | ADMIN | Agent management |
| `/copilot` | ADMIN | AI copilot settings |
| `/first-take-care` | ADMIN | Autonomous AI settings |
| `/settings` | ADMIN | Business hours, SLA, automation |
| `/setup` | ADMIN | Onboarding wizard |

**System Admin Pages (SystemLayout):**
| Route | Role | Description |
|-------|------|-------------|
| `/system` | SYSTEM_ADMIN | System dashboard |
| `/system/tenants` | SYSTEM_ADMIN | Tenant management |
| `/system/tenants/[id]` | SYSTEM_ADMIN | Tenant details |

### 7.2 Key Components

| Component | Purpose |
|-----------|---------|
| AppLayout | Responsive shell with sidebar + mobile nav |
| Sidebar | Navigation, user info, language switcher |
| ConversationList | Filterable conversation list with real-time updates |
| ChatPanel | Message thread, actions, side panels |
| CoPilotPanel | AI suggestion viewer |
| HistoryPanel | Past conversations + notes |
| SystemLayout | System admin shell |

### 7.3 Real-Time Integration

Socket.IO events consumed:
- `conversation:updated` -> refresh conversation list
- `conversation:closed` -> update conversation status
- `message:new` -> append message to thread
- `message:status` -> update delivery indicator
