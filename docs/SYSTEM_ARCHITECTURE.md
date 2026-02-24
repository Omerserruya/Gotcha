# ChatCenter - System Architecture Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack](#2-technology-stack)
3. [Service Architecture](#3-service-architecture)
4. [Infrastructure Components](#4-infrastructure-components)
5. [Communication Patterns](#5-communication-patterns)
6. [Data Model](#6-data-model)
7. [Business Flows](#7-business-flows)
8. [Security Architecture](#8-security-architecture)
9. [Deployment Architecture](#9-deployment-architecture)

---

## 1. Overview

ChatCenter is a **multi-tenant SaaS platform** for omnichannel customer communication management. It enables businesses to manage customer conversations across WhatsApp, Facebook Messenger, and Instagram from a unified interface, with AI-powered copilot assistance, automated chatbot flows, and intelligent conversation routing.

### Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Omnichannel Messaging** | WhatsApp Business, Facebook Messenger, Instagram DM |
| **AI Copilot** | Real-time agent suggestions, conversation summaries, intent classification |
| **Chatbot Builder** | Visual flow editor with conditional routing and department handover |
| **Team Management** | Departments, roles (Admin/Agent/Manager), round-robin & claim queues |
| **Conversation Routing** | Auto-assignment, department transfer, SLA tracking, escalation |
| **Tenant Governance** | System admin panel, tenant lifecycle, onboarding wizard |
| **Real-Time** | WebSocket-powered live updates across all connected agents |
| **Automation** | Business hours, auto-greeting, idle reminders, auto-close |

---

## 2. Technology Stack

### Backend
| Technology | Purpose |
|-----------|---------|
| Node.js 20 + TypeScript 5.6 | Runtime & language |
| Express.js | HTTP server framework |
| Prisma ORM | Database access & migrations |
| PostgreSQL 16 | Relational database |
| Redis 7 | Cache, pub/sub, job queues |
| BullMQ | Distributed job queue framework |
| Socket.IO 4.8 | Real-time WebSocket server |
| OpenAI SDK 6.22 | AI provider integration |
| bcryptjs | Password hashing |
| jsonwebtoken | JWT authentication |
| Nodemailer | Email sending (SMTP) |
| Zod | Request schema validation |

### Frontend
| Technology | Purpose |
|-----------|---------|
| Next.js 14.2 (App Router) | React framework |
| React 18.3 | UI library |
| TypeScript 5.6 | Type safety |
| Tailwind CSS 3.4 | Styling |
| Socket.IO Client 4.8 | Real-time WebSocket client |
| Recharts 2.12 | Analytics charts |
| ReactFlow 11.11 | Visual chatbot flow editor |
| date-fns 3.6 | Date manipulation |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| Docker & Docker Compose | Containerization & orchestration |
| Nginx (Alpine) | API gateway / reverse proxy |

---

## 3. Service Architecture

ChatCenter is a **monorepo** with npm workspaces, organized into 8 microservices, 1 shared package, and 1 frontend application.

### 3.1 Service Overview

```
ChatCenter/
  packages/
    shared/          @chatcenter/shared - Shared library (Prisma, queues, auth, adapters)
  services/
    auth/            Port 4001 - Authentication, agents, departments, channels, onboarding
    conversation/    Port 4002 - Conversation CRUD + Socket.IO WebSocket server
    webhook/         Port 4003 - Inbound webhook receiver (WhatsApp, Messenger, Instagram)
    analytics/       Port 4004 - Analytics queries & aggregation
    chatbot/         Port 4005 - Chatbot flow CRUD & management
    ai/              Port 4006 - AI copilot service (OpenAI integration)
    incoming-worker/ (no HTTP) - Queue consumer for inbound message processing
    outgoing-worker/ (no HTTP) - Queue consumer for outbound message delivery
  frontend/          Port 3000 - Next.js web application
  nginx/             Port 80   - API gateway
```

### 3.2 Service Details

#### Auth Service (Port 4001)
**Responsibility:** Central hub for identity, access control, tenant management, and configuration.

| Domain | Endpoints | Description |
|--------|-----------|-------------|
| Authentication | `/api/auth/*` | Login, register, magic link verification, session |
| Agents | `/api/agents/*` | Agent CRUD, settings (greeting, business hours, SLA, copilot, idle automation) |
| Departments | `/api/departments/*` | Department CRUD, member management, dept copilot config |
| Channels | `/api/channels/*` | OAuth connect/disconnect WhatsApp, Messenger, Instagram |
| Onboarding | `/api/onboarding/*` | Tenant onboarding wizard (business profile, departments, AI config) |
| System Admin | `/api/system/*` | Tenant CRUD, system stats, user management, feature toggles |

**Key Services:**
- `AuthService` - Login/register with bcrypt + JWT
- `AgentConfigGenerator` - Generates structured AI agent configs per department
- `NotificationService` - Email notifications (onboarding, activation) + magic links

---

#### Conversation Service (Port 4002)
**Responsibility:** Conversation lifecycle management and real-time WebSocket relay.

| Domain | Endpoints | Description |
|--------|-----------|-------------|
| Conversations | `/api/conversations/*` | List, get, claim, release, reassign, close, delete |
| Messages | `/api/conversations/:id/messages` | List messages, send outbound message, delete |
| Stats | `/api/conversations/stats/workload` | Agent workload distribution |
| History | `/api/conversations/history/:phone` | Customer conversation history |
| WebSocket | `/socket.io/*` | Real-time event relay to frontend clients |

**Key Features:**
- Socket.IO server with Redis adapter (multi-instance)
- JWT-authenticated WebSocket connections
- Tenant-scoped rooms (`tenant:{tenantId}`)
- Cross-service event subscription and relay
- Round-robin department assignment
- Auto-greeting on claim/reassign
- Async AI summary on conversation close

---

#### Webhook Service (Port 4003)
**Responsibility:** Receive and normalize inbound webhooks from Meta platforms.

| Function | Description |
|----------|-------------|
| Signature Verification | HMAC SHA256 webhook signature validation |
| Platform Detection | Auto-detect WhatsApp, Messenger, or Instagram payloads |
| Message Normalization | Convert platform-specific formats to internal `NormalizedInboundMessage` |
| Tenant Resolution | Lookup tenant via `ChannelAccount.externalId` |
| Job Enqueue | Push `IncomingMessageJob` to Redis queue |
| Status Updates | Process delivery/read receipts inline |

---

#### AI Service (Port 4006)
**Responsibility:** AI-powered assistance for agents and conversation intelligence.

| Endpoint | Description |
|----------|-------------|
| `GET /api/ai-assist/config` | Tenant copilot configuration |
| `GET /api/ai-assist/:id/suggestions` | Generate 2-3 reply suggestions for conversation |
| `GET /api/ai-assist/:id/summary` | Generate 2-3 sentence conversation summary |
| `GET /api/ai-assist/prompt/:deptId` | Debug: view assembled system prompt |

**Key Features:**
- Dynamic prompt assembly from structured config blocks (identity, goals, tone, behavioral, mode, tools)
- 3-level config hierarchy: Tenant -> Department -> AgentConfig
- Provider pattern: OpenAI (default) or StubAI (fallback)
- JSON response mode for structured suggestions
- Temperature tuning per task (0.7 suggestions, 0.3 summary, 0 classification)

---

#### Incoming Worker (Queue Consumer)
**Responsibility:** Asynchronous processing of inbound messages from all channels.

| Worker | Schedule | Description |
|--------|----------|-------------|
| Incoming Message | Queue-driven (concurrency: 3) | Process inbound messages, create conversations, run chatbot flows |
| Channel Health | Every 6h / 12h | Monitor token validity, refresh expiring tokens |
| Idle Conversation | Every 5 min | Send reminders, auto-close idle conversations |

**Message Processing Pipeline:**
1. Validate tenant (must be ACTIVE)
2. Idempotency check (deduplicate by `externalMessageId`)
3. Fetch customer profile from Meta API
4. Find or create conversation
5. Create message record
6. Publish real-time events
7. Queue analytics job
8. Execute chatbot flow (if no agent assigned)

**Chatbot Engine:**
- Visual flow execution (start, message, quick_reply, condition, handover, department_route, end)
- Business hours check with auto-response
- Department routing with round-robin
- Max 20 execution steps (loop prevention)

---

#### Outgoing Worker (Queue Consumer)
**Responsibility:** Send outbound messages to channel APIs.

| Function | Description |
|----------|-------------|
| Message Delivery | Send text/interactive messages via Meta Graph API |
| Retry Logic | 3 attempts with exponential backoff (1s initial) |
| Status Updates | Update message status (SENT/FAILED) |
| Channel Adapters | WhatsApp, Messenger, Instagram outbound adapters |

---

#### Analytics Service (Port 4004)
**Responsibility:** Analytics aggregation and reporting.

| Function | Description |
|----------|-------------|
| Dashboard Stats | KPIs (active convos, queue depth, response times) |
| Agent Stats | Per-agent performance metrics |
| Volume Analysis | Hourly/daily conversation volume |
| Queue Stats | Queue depth and wait times |

---

#### Chatbot Service (Port 4005)
**Responsibility:** Chatbot flow management.

| Function | Description |
|----------|-------------|
| Flow CRUD | Create, update, delete chatbot flows |
| Flow Activation | Activate/deactivate flows per channel |
| Flow Storage | JSON-based node/edge graph definitions |

---

### 3.3 Shared Package (@chatcenter/shared)

The shared package provides cross-cutting concerns used by all services:

| Module | Exports |
|--------|---------|
| **Database** | Prisma client, generated types |
| **Auth** | JWT sign/verify, bcrypt utilities |
| **Encryption** | Credential encrypt/decrypt (AES) |
| **Queues** | 5 BullMQ queues (incoming, outgoing, analytics, channel-health, idle-conversation) |
| **Event Bus** | Redis pub/sub (publishEvent, subscribeToEvents) |
| **Middleware** | authenticate, requireRole, resolveTenant, requireActiveTenant, validate |
| **Channel Adapters** | Inbound/outbound adapters for WhatsApp, Messenger, Instagram |
| **Service Factory** | createServiceApp(), startService() - Express app bootstrap |
| **Types** | JwtPayload, ServiceEvent, job types, channel types |

---

## 4. Infrastructure Components

### 4.1 PostgreSQL 16
- Single shared instance for all services
- Multi-tenant data isolation via `tenantId` foreign keys
- 16 tables, 13 enums, 21 cascade-delete foreign keys
- Prisma ORM with migration management

### 4.2 Redis 7
- **Job Queues:** 5 BullMQ queues for async processing
- **Pub/Sub:** Cross-service event bus (`chatcenter:events` channel)
- **Socket.IO Adapter:** Multi-instance WebSocket coordination
- **Cache:** Tenant settings (business hours, SLA, auto-greeting, idle automation)

### 4.3 Nginx Gateway
- Reverse proxy routing to all services
- WebSocket upgrade support (`/socket.io/`)
- Rate limiting (100 req/s global, stricter for auth endpoints)
- Tenant-scoped routing: `/t/{tenantId}/api/*` extracts `X-Tenant-ID` header
- 10MB max body size for webhooks

---

## 5. Communication Patterns

### 5.1 Synchronous (HTTP/REST)

All service-to-service HTTP calls go through Nginx gateway.

```
Frontend  -->  Nginx  -->  Auth Service (4001)
                      -->  Conversation Service (4002)
                      -->  Webhook Service (4003)
                      -->  Analytics Service (4004)
                      -->  Chatbot Service (4005)
                      -->  AI Service (4006)
```

### 5.2 Asynchronous (BullMQ Job Queues)

| Queue | Producer | Consumer | Job Type |
|-------|----------|----------|----------|
| `incoming-messages` | Webhook Service | Incoming Worker | IncomingMessageJob |
| `outgoing-messages` | Conversation Service, Chatbot Engine | Outgoing Worker | OutgoingMessageJob |
| `analytics-aggregation` | Incoming Worker, others | Analytics Service | AnalyticsJob |
| `channel-health` | Scheduled (cron) | Channel Health Worker | Health check / token refresh |
| `idle-conversations` | Scheduled (cron) | Idle Conversation Worker | Reminder / auto-close |

### 5.3 Event-Driven (Redis Pub/Sub)

Channel: `chatcenter:events`

| Event | Publisher | Subscriber | Purpose |
|-------|-----------|------------|---------|
| `message:new` | Message Service | Conversation Service (Socket.IO) | Real-time new message |
| `message:status` | Message Service | Conversation Service (Socket.IO) | Delivery status update |
| `conversation:updated` | Conversation Service | Conversation Service (Socket.IO) | Conversation state change |
| `conversation:closed` | Conversation Service | Conversation Service (Socket.IO) | Conversation closed |
| `tenant:created` | System Routes | - | Tenant lifecycle event |
| `tenant:activated` | Onboarding Routes | - | Onboarding completed |

### 5.4 Real-Time (WebSocket / Socket.IO)

- Server: Conversation Service (port 4002)
- Auth: JWT token validation on connection
- Rooms: `tenant:{tenantId}`, `user:{userId}`
- Transport: WebSocket with polling fallback
- Adapter: Redis (multi-instance coordination)

Events relayed to frontend:
- `conversation:updated`, `conversation:closed`
- `message:new`, `message:status`

---

## 6. Data Model

### 6.1 Entity Relationship Summary

```
Tenant (root)
  |-- User (SYSTEM_ADMIN / ADMIN / AGENT)
  |     |-- DepartmentMember (AGENT / MANAGER)
  |
  |-- Department
  |     |-- DepartmentMember
  |     |-- DepartmentCopilotConfig
  |     |-- AgentConfig
  |     |-- Conversation (via departmentId)
  |
  |-- ChannelAccount (WHATSAPP / MESSENGER / INSTAGRAM)
  |     |-- Conversation (via channelAccountId)
  |
  |-- Conversation
  |     |-- Message
  |
  |-- ChatbotFlow
  |     |-- Conversation (via chatbotFlowId)
  |
  |-- CopilotConfig (1:1)
  |-- FirstTakeCareConfig (1:1)
  |-- BusinessProfile (1:1)
  |-- TenantOnboarding (1:1)
  |-- TenantChannelConfig (1:1)
  |-- MagicLink
  |-- NotificationLog
```

### 6.2 Key Enums

| Enum | Values |
|------|--------|
| Role | SYSTEM_ADMIN, ADMIN, AGENT |
| DepartmentRole | AGENT, MANAGER |
| TenantStatus | PENDING_ADMIN_SETUP, PENDING_ONBOARDING, ACTIVE, SUSPENDED |
| OnboardingStep | BUSINESS_PROFILE, DEPARTMENTS, AI_CONFIG, COMPLETED |
| ChannelType | WHATSAPP, MESSENGER, INSTAGRAM |
| ConversationStatus | OPEN, WAITING, CLOSED |
| MessageDirection | INBOUND, OUTBOUND |
| MessageStatus | PENDING, SENT, DELIVERED, READ, FAILED |
| QueueMode | CLAIM, ROUND_ROBIN |
| AIMode | COPILOT, AUTONOMOUS, HYBRID |
| CopilotMode | READY_MESSAGE, CONTEXT_ONLY |
| BotFlowMode | UNIFIED, PER_CHANNEL |
| BusinessPriority | MAXIMIZE_SALES, FAST_RESPONSE, PREMIUM_EXPERIENCE, REDUCE_WORKLOAD |

### 6.3 Multi-Tenant Isolation

- All tables include `tenantId` foreign key (cascade delete)
- All queries filtered by `tenantId`
- Unique constraints scoped per tenant (e.g., `(tenantId, email)`)
- WebSocket rooms scoped to tenant
- SYSTEM_ADMIN bypasses tenant checks

---

## 7. Business Flows

### 7.1 Tenant Lifecycle

```
[System Admin creates tenant]
    |
    v
PENDING_ADMIN_SETUP  -->  Magic link email sent (48h expiry)
    |
    v  (Admin clicks magic link or logs in)
PENDING_ONBOARDING
    |
    v  Step 1: Business Profile (industry, priority, AI mode)
    v  Step 2: Department Configuration (name, queue mode, SLA)
    v  Step 3: AI Chat (optional fine-tuning with LLM)
    v  Step 4: Generate Agent Configs
    v  Step 5: Complete Onboarding
    |
    v
ACTIVE  -->  Activation email sent
    |
    v  (System Admin can suspend)
SUSPENDED
```

### 7.2 Inbound Message Flow

```
[Customer sends message on WhatsApp/Messenger/Instagram]
    |
    v
Meta Platform  --webhook-->  Nginx  -->  Webhook Service (4003)
    |
    v  Verify signature, normalize, resolve tenant
    |
    v  Enqueue IncomingMessageJob
    |
    v
Incoming Worker
    |
    v  1. Validate tenant (ACTIVE)
    v  2. Dedup by externalMessageId
    v  3. Fetch customer profile from Meta API
    v  4. Find or create Conversation
    v  5. Create Message (INBOUND, DELIVERED)
    v  6. Publish events (message:new, conversation:updated)
    v  7. Queue analytics job
    |
    v  [If no agent assigned and not handed over]
    |
    v
Chatbot Engine
    |
    v  Select flow (UNIFIED or PER_CHANNEL)
    v  Execute nodes: message, quick_reply, condition
    v  Department route: check business hours, round-robin assign
    v  Handover: set isHandedOver=true, status=WAITING
    |
    v
Socket.IO  -->  Frontend (real-time update)
```

### 7.3 Outbound Message Flow (Agent Sends)

```
[Agent types and sends message in frontend]
    |
    v
Frontend  -->  POST /api/conversations/:id/messages
    |
    v
Conversation Service
    |
    v  1. Create Message (OUTBOUND, PENDING)
    v  2. Enqueue OutgoingMessageJob (3 retries, exponential backoff)
    v  3. Emit message:new event
    |
    v
Outgoing Worker
    |
    v  1. Select channel adapter (WhatsApp/Messenger/Instagram)
    v  2. Send via Meta Graph API
    v  3. Update message status (SENT or FAILED)
    v  4. Publish message:status event
    |
    v
Socket.IO  -->  Frontend (status update: sent/delivered/read)
```

### 7.4 Conversation Assignment Flow

```
[New conversation arrives in queue]
    |
    +--> CLAIM mode: Agent manually claims via UI
    |      POST /api/conversations/:id/claim
    |      - Prevents double-claim (409 conflict)
    |      - Creates system message "agent_claimed"
    |      - Sends auto-greeting
    |
    +--> ROUND_ROBIN mode: Auto-assigned on department transfer
           - Selects agent with fewest active conversations
           - Falls back to WAITING if no available agents
           - Creates system message "department_transferred"
           - Sends auto-greeting from assigned agent

[Reassignment]
    POST /api/conversations/:id/reassign {agentId} or {departmentId}
    - ADMIN: can reassign any conversation
    - AGENT: can only reassign own conversations
    - Department transfer triggers round-robin
    - System message with from/to agent names
    - Auto-greeting from new agent

[Release]
    POST /api/conversations/:id/release
    - Clears assignedAgentId
    - Sets status back to OPEN

[Close]
    POST /api/conversations/:id/close
    - Sets status=CLOSED, closedAt=now
    - Async: fetches AI summary from AI service
    - Saves summary to conversation.aiSummary
```

### 7.5 AI Copilot Flow

```
[Agent opens conversation in UI]
    |
    v
CoPilotPanel  -->  GET /api/ai-assist/:conversationId/suggestions
    |
    v
AI Service
    |
    v  1. Fetch last 20 messages
    v  2. Assemble config:
    v     Priority: DepartmentCopilotConfig.systemPrompt
    v             > DepartmentCopilotConfig blocks (assembled)
    v             > AgentConfig blocks (backward compat)
    v             > TenantCopilotConfig (fallback)
    v  3. Inject conversation context (customer name, history)
    v  4. Call OpenAI (JSON mode, temperature from config)
    |
    v
Response: 2-3 suggestions [{text, confidence, type}]
    |
    v
Agent clicks suggestion --> inserted into message input
```

### 7.6 Channel Connection Flow (WhatsApp OAuth)

```
[Admin initiates WhatsApp connection in frontend]
    |
    v
GET /api/channels/oauth/init  -->  Generate state JWT (10min)
    |
    v  Redirect to Meta OAuth login
    |
    v  User grants permissions
    |
    v
Meta  --callback-->  GET /api/channels/oauth/callback
    |
    v  1. Verify state JWT
    v  2. Exchange code for business token (365-day)
    v  3. Discover WABA + phone numbers
    v  4. Register phone (if WhatsApp)
    v  5. Subscribe to webhooks
    v  6. Encrypt and store credentials
    v  7. Create/update ChannelAccount (CONNECTED)
    |
    v
Channel ready to receive webhooks
```

### 7.7 Idle Conversation Automation

```
[Every 5 minutes - Idle Conversation Worker]
    |
    v  For each tenant with idle automation enabled:
    |
    v  Find conversations where:
    v    - Status: OPEN or WAITING
    v    - Has assigned agent
    v    - Last message is OUTBOUND (agent waiting)
    v    - Last message is not system message
    |
    v  Calculate idle time = now - lastMessageAt
    |
    +--> Auto-Close (if elapsed >= autoCloseDelayMinutes)
    |      - Send close message to customer
    |      - Set status=CLOSED
    |      - Create system message "auto_closed"
    |      - Publish conversation:closed
    |
    +--> Reminder (if elapsed >= reminderDelayMinutes)
           - Check if reminder already sent after last agent msg
           - Send reminder message to customer
           - Update reminderSentAt
           - Publish conversation:updated
```

---

## 8. Security Architecture

### 8.1 Authentication

| Mechanism | Details |
|-----------|---------|
| Password Hashing | bcryptjs with 10 salt rounds |
| JWT Tokens | Signed with HS256, 24h expiry |
| Magic Links | 32-byte random hex, 48h expiry, one-time use |
| Webhook Verification | HMAC SHA256 signature validation |
| OAuth State | JWT-signed state parameter (10min expiry) |

### 8.2 Authorization (RBAC)

| Role | Scope |
|------|-------|
| SYSTEM_ADMIN | Full platform access, bypasses tenant checks |
| ADMIN | Full tenant access, manage agents/departments/channels/settings |
| AGENT | Conversation access scoped to department + own assignments |
| MANAGER (dept) | Department-level management + agent-level conversation access |

### 8.3 Data Protection

| Protection | Details |
|-----------|---------|
| Credential Encryption | AES encryption for channel tokens/credentials |
| Tenant Isolation | All queries filtered by tenantId |
| Tenant Status Gates | requireActiveTenant middleware blocks non-ACTIVE tenants |
| Input Validation | Zod schema validation on all endpoints |

### 8.4 Rate Limiting

| Endpoint | Limit |
|----------|-------|
| Global (Nginx) | 100 req/s |
| Auth endpoints | 30 req/15min per IP |
| OAuth endpoints | 20 req/15min per IP |
| Conversation API | 50 burst/s |
| Other APIs | 20 burst/s |

---

## 9. Deployment Architecture

### 9.1 Docker Compose Services

| Service | Image | Port | Replicas |
|---------|-------|------|----------|
| db | postgres:16-alpine | 5432 | 1 |
| redis | redis:7-alpine | 6379 | 1 |
| nginx | nginx:alpine | 80 | 1 |
| auth | node:20-alpine | 4001 | 1 |
| conversation | node:20-alpine | 4002 | 1 |
| webhook | node:20-alpine | 4003 | 1 |
| analytics | node:20-alpine | 4004 | 1 |
| chatbot | node:20-alpine | 4005 | 1 |
| ai | node:20-alpine | 4006 | 1 |
| incoming-worker | node:20-alpine | - | configurable |
| outgoing-worker | node:20-alpine | - | configurable |
| frontend | node:20-alpine | 3000 | 1 |
| migrate | node:20-alpine | - | 1 (one-time) |

### 9.2 Scalability

- Workers are independently scalable via `INCOMING_WORKER_REPLICAS` and `OUTGOING_WORKER_REPLICAS`
- Socket.IO uses Redis adapter for multi-instance coordination
- All services are stateless (state in PostgreSQL + Redis)
- BullMQ provides automatic job distribution across worker replicas

### 9.3 Health Checks

- PostgreSQL: `pg_isready` check
- Redis: `redis-cli ping` check
- All services depend on db + redis health
- Channel health monitored every 6h with token refresh every 12h

---

## Appendix: Environment Variables

See `.env.example` for the full list. Key categories:
- **Database:** `DATABASE_URL`, `POSTGRES_*`
- **Security:** `JWT_SECRET`, `CHANNEL_ENCRYPTION_KEY`, `SYSTEM_ADMIN_SETUP_SECRET`
- **Services:** `AUTH_PORT`, `CONVERSATION_PORT`, `WEBHOOK_PORT`, etc.
- **Meta Platform:** `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_*`
- **AI:** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DEFAULT_MODEL`
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- **Frontend:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`
- **Workers:** `INCOMING_WORKER_REPLICAS`, `OUTGOING_WORKER_REPLICAS`
