# ChatCenter Omnichannel Architecture

## Status: Design Document
## Date: 2026-02-17

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [High-Level Architecture Overview](#2-high-level-architecture-overview)
3. [Core System Components](#3-core-system-components)
4. [Data Model Concepts](#4-data-model-concepts)
5. [Message Flow: End to End](#5-message-flow-end-to-end)
6. [Tenant Configuration: Dual-Mode Bot Flows](#6-tenant-configuration-dual-mode-bot-flows)
7. [UI / Agent Experience](#7-ui--agent-experience)
8. [Extensibility Strategy](#8-extensibility-strategy)
9. [Migration Path](#9-migration-path)

---

## 1. Current State Analysis

### What Exists Today

ChatCenter is a multi-tenant WhatsApp Business communication platform with this pipeline:

```
WhatsApp Cloud API
  -> Webhook Service (signature verify, tenant resolve by waPhoneNumberId)
    -> BullMQ "incoming-messages" queue
      -> Incoming Worker (find/create conversation, store message, run chatbot)
        -> Chatbot Engine (graph-based flow, direct WhatsApp API calls)
        -> Event Bus (Redis pub/sub -> Socket.IO -> Frontend)
```

### Where WhatsApp Is Hardcoded

| Layer | Coupling Point |
|-------|---------------|
| **Tenant model** | `waPhoneNumberId`, `waAccessToken`, `waWebhookSecret` fields directly on `Tenant` |
| **Webhook route** | Checks `body.object === "whatsapp_business_account"`, parses WA-specific payload structure |
| **Tenant resolution** | Looks up tenant by `waPhoneNumberId` -- no concept of multiple channels per tenant |
| **Incoming worker** | `extractMessageBody()` parses WA message types (`msg.text.body`, `msg.interactive.button_reply`) |
| **Conversation model** | `customerPhone` as sole customer identifier -- phone-centric |
| **Message model** | `waMessageId` for delivery correlation -- WA-specific |
| **Chatbot engine** | Directly calls `sendWhatsAppMessage()` and `sendQuickReply()` with WA API format |
| **Outgoing worker** | Calls `POST /{phoneNumberId}/messages` with `messaging_product: "whatsapp"` |
| **Status updates** | Parses WA-specific status webhook (`status.id`, `status.status`) |

**Key insight**: There is zero channel abstraction. Every service layer directly references WhatsApp concepts. Adding Messenger requires introducing a proper abstraction boundary, not just bolting on a second code path.

---

## 2. High-Level Architecture Overview

### Design Principles

1. **Single webhook entry point** -- One Meta webhook URL handles both WhatsApp and Messenger
2. **Detect, normalize, route** -- Platform detection happens once; everything downstream works with normalized messages
3. **Channel-agnostic core** -- Conversation management, bot engine, agent inbox, and AI operate on a unified message model
4. **Channel-aware edges** -- Only the inbound parser and outbound sender know platform specifics
5. **Tenant-scoped channel config** -- Each tenant independently configures which channels are active and how bot flows are routed

### Architecture Layers

```
                    +-----------------------------------------+
                    |           META WEBHOOK ENDPOINT          |
                    |  (Single URL for WhatsApp + Messenger)   |
                    +---------+---------------+---------------+
                              |               |
                    +---------v----+  +-------v---------+
                    |  WA Parser   |  | Messenger Parser |   <-- CHANNEL ADAPTERS (Inbound)
                    +---------+----+  +-------+---------+
                              |               |
                    +---------v---------------v---------+
                    |       NORMALIZED MESSAGE MODEL      |   <-- INTERNAL CANONICAL FORMAT
                    |  { channel, senderId, body, ... }   |
                    +------------------+------------------+
                                       |
                    +------------------v------------------+
                    |          INCOMING QUEUE              |
                    |     (BullMQ: incoming-messages)      |
                    +------------------+------------------+
                                       |
                    +------------------v------------------+
                    |          INCOMING WORKER             |
                    |  - Find/create conversation          |
                    |  - Store normalized message           |
                    |  - Route to chatbot or agent queue    |
                    +------------------+------------------+
                                       |
                 +---------------------+---------------------+
                 |                                           |
    +------------v-----------+                 +-------------v-----------+
    |     CHATBOT ENGINE     |                 |      AGENT INBOX        |
    | (channel-agnostic flow |                 | (unified conversation   |
    |  execution with channel|                 |  view, channel badge,   |
    |  -aware send adapter)  |                 |  reply via correct      |
    +------------+-----------+                 |  channel automatically) |
                 |                             +-------------+-----------+
                 |                                           |
    +------------v-------------------------------------------v-----------+
    |                    OUTGOING QUEUE                                   |
    |               (BullMQ: outgoing-messages)                          |
    +----------------------------+---------------------------------------+
                                 |
                    +------------v-----------+
                    |    CHANNEL ROUTER      |
                    | (selects correct sender)|
                    +------+----------+------+
                           |          |
                 +---------v--+  +----v-----------+
                 | WA Sender  |  | Messenger Sender|   <-- CHANNEL ADAPTERS (Outbound)
                 +------------+  +-----------------+
```

### Key Architectural Boundaries

```
  CHANNEL-SPECIFIC          CHANNEL-AGNOSTIC              CHANNEL-SPECIFIC
  (Inbound Adapters)        (Core Platform)               (Outbound Adapters)
  ==================        ===============               ==================
  WA Webhook Parser         Incoming Worker               WA Message Sender
  Messenger Parser          Conversation Service          Messenger Sender
  Status Normalizer         Chatbot Engine                Status Mapper
                            AI / CoPilot
                            Agent UI / Socket.IO
                            Analytics
```

The **abstraction boundary** is the Normalized Message Model. Everything left of it is channel-specific inbound logic. Everything right of it is channel-specific outbound logic. The entire middle is channel-agnostic.

---

## 3. Core System Components

### 3.1 Channel Registry

**Responsibility**: Defines what channels exist in the system and their capabilities.

```
ChannelRegistry
  - Registered channels: WHATSAPP, MESSENGER, (future: INSTAGRAM, TELEGRAM, SMS)
  - Per channel:
      - Identifier type (phone number, PSID, username)
      - Supported message types (text, image, quick_reply, template, etc.)
      - Supported interactive elements (buttons, lists, carousels)
      - Rate limits and constraints
      - Delivery receipt behavior
```

This is a **static, code-level registry** -- not a database table. Adding a new channel means implementing the adapter interface and registering it here.

### 3.2 Channel Adapters (Inbound)

**Responsibility**: Parse platform-specific webhook payloads into the normalized message model.

Each adapter implements:
```
interface InboundAdapter {
  canHandle(webhookPayload): boolean          // "Is this my platform?"
  extractMessages(payload): NormalizedInboundMessage[]
  extractStatusUpdates(payload): NormalizedStatusUpdate[]
  resolveChannelAccountId(payload): string    // e.g., phoneNumberId for WA, pageId for Messenger
}
```

**WhatsApp Adapter**:
- Detects: `body.object === "whatsapp_business_account"`
- Extracts: `value.messages[*]` -> NormalizedInboundMessage
- Customer ID: phone number (`msg.from`)
- Account ID: `value.metadata.phone_number_id`
- Maps: `msg.text.body`, `msg.interactive.button_reply.title`, media types

**Messenger Adapter**:
- Detects: `body.object === "page"`
- Extracts: `entry[*].messaging[*]` -> NormalizedInboundMessage
- Customer ID: PSID (Page-Scoped ID, `messaging.sender.id`)
- Account ID: `messaging.recipient.id` (page ID)
- Maps: `message.text`, `message.attachments`, postback payloads, quick reply payloads

### 3.3 Channel Adapters (Outbound)

**Responsibility**: Convert normalized outbound messages to platform-specific API calls.

Each adapter implements:
```
interface OutboundAdapter {
  sendTextMessage(channelAccount, recipientId, text): ExternalMessageId
  sendInteractiveMessage(channelAccount, recipientId, interactivePayload): ExternalMessageId
  sendMedia(channelAccount, recipientId, mediaPayload): ExternalMessageId
  mapCapabilities(messageIntent): PlatformSpecificPayload  // graceful degradation
}
```

**Key design decision**: The outbound adapter handles **capability mapping**. If the chatbot sends a quick_reply with 4 buttons, and a future channel only supports 3, the adapter handles the degradation (e.g., fall back to numbered text list).

### 3.4 Webhook Gateway (Enhanced Webhook Service)

**Responsibility**: Single Meta webhook endpoint that detects platform and delegates to the correct inbound adapter.

```
POST /api/webhook
  1. Verify signature (platform-specific secret)
  2. Detect platform: iterate registered InboundAdapters, call canHandle()
  3. Extract channel account ID (phoneNumberId or pageId)
  4. Resolve tenant via ChannelAccount lookup (replaces direct waPhoneNumberId lookup)
  5. Normalize messages via adapter
  6. Enqueue to incoming-messages queue WITH channel metadata
```

**Why a single endpoint**: Meta's Graph API allows a single webhook URL for a Meta App. That app can have both WhatsApp and Messenger products enabled. The payload structure differs, but both arrive at the same URL.

### 3.5 Channel Account Model (New)

**Responsibility**: Decouple channel credentials from the Tenant model. A tenant can have multiple channel accounts (one WhatsApp number, one Messenger page, potentially multiple of each).

```
ChannelAccount
  - id
  - tenantId
  - channel: WHATSAPP | MESSENGER | ...
  - externalAccountId: string    // waPhoneNumberId or FB Page ID
  - credentials: encrypted JSON  // accessToken, appSecret, etc.
  - displayName: string          // "Main WhatsApp" or "Support Page"
  - isActive: boolean
  - metadata: JSON               // channel-specific config
```

**Tenant resolution at webhook time**: Instead of `tenant.findFirst({ waPhoneNumberId })`, the system queries `channelAccount.findFirst({ externalAccountId, channel })` and retrieves the associated tenant.

### 3.6 Normalized Message Model

**Responsibility**: The canonical internal representation that all core services operate on.

```
NormalizedInboundMessage {
  externalMessageId: string      // WA message ID or Messenger mid
  channel: ChannelType           // WHATSAPP | MESSENGER
  channelAccountId: string       // FK to ChannelAccount
  senderId: string               // Customer's channel-specific ID (phone or PSID)
  senderDisplayName?: string     // From contact profile or FB profile
  timestamp: DateTime
  content: {
    type: TEXT | IMAGE | DOCUMENT | AUDIO | VIDEO | INTERACTIVE | LOCATION
    text?: string
    mediaUrl?: string
    caption?: string
    interactiveReply?: {          // Button click, quick reply, postback
      type: BUTTON | QUICK_REPLY | POSTBACK
      payload: string
      title: string
    }
  }
}
```

### 3.7 Unified Conversation Service (Enhanced)

**Responsibility**: Manage conversations. Now channel-aware but channel-agnostic in logic.

Key changes from current:
- Conversation is identified by `(tenantId, channelAccountId, customerExternalId)` instead of `(tenantId, customerPhone)`
- The `channel` field on the conversation tells the UI which badge to show
- The `channelAccountId` tells the outgoing system which credentials to use
- Cross-channel customer linking is a **future concern** (see Section 8)

### 3.8 Chatbot Engine (Enhanced)

**Responsibility**: Execute bot flows. Now channel-agnostic with channel-aware sending.

Key changes:
- Instead of directly calling `sendWhatsAppMessage()`, the engine calls a unified `sendBotMessage(channelAccountId, recipientId, messagePayload)` function
- That function resolves the channel from the ChannelAccount and delegates to the correct OutboundAdapter
- The flow graph remains the same -- nodes and edges are channel-agnostic
- Interactive elements (quick_reply) are expressed in the normalized format; the outbound adapter maps them to platform-specific interactive payloads
- **Capability negotiation**: If a flow uses a feature unsupported on a channel (e.g., list messages on Messenger), the adapter provides graceful fallback

---

## 4. Data Model Concepts

### 4.1 New: ChannelAccount

```
ChannelAccount
  id              PK
  tenantId        FK -> Tenant
  channel         enum: WHATSAPP, MESSENGER, (extensible)
  externalId      string    // Platform account ID (phone_number_id, page_id)
  displayName     string    // Human label: "Main WhatsApp Line"
  credentials     JSON      // Encrypted: { accessToken, appSecret, ... }
  isActive        boolean
  createdAt       timestamp
  updatedAt       timestamp

  UNIQUE(channel, externalId)    // One row per platform account globally
  INDEX(tenantId)
```

**Migration from current Tenant fields**: The existing `waPhoneNumberId`, `waAccessToken`, `waWebhookSecret` fields on `Tenant` are migrated to a `ChannelAccount` row with `channel=WHATSAPP`. The Tenant model becomes channel-free.

### 4.2 Modified: Conversation

```
Conversation (changes highlighted)
  id
  tenantId
+ channel              enum: WHATSAPP, MESSENGER, ...
+ channelAccountId     FK -> ChannelAccount
+ customerExternalId   string    // Phone number (WA) or PSID (Messenger)
  customerName
- customerPhone        (replaced by customerExternalId)
  assignedAgentId
  status
  chatbotFlowId
  chatbotNodeId
  isHandedOver
  lastMessageAt
  closedAt
  createdAt
  updatedAt

  INDEX(tenantId, channel, customerExternalId)   // Find open conversation per customer per channel
  INDEX(tenantId, status)
  INDEX(tenantId, assignedAgentId)
```

**Key decisions**:
- `channel` is denormalized on the Conversation for fast filtering and display (avoids joining to ChannelAccount on every query)
- `customerExternalId` replaces `customerPhone` -- it holds whatever the platform uses as the customer identifier
- A customer who contacts via both WhatsApp and Messenger gets **two separate conversations**. Cross-channel identity linking is a future feature (see Section 8).

### 4.3 Modified: Message

```
Message (changes highlighted)
  id
  tenantId
  conversationId
+ channel               enum: WHATSAPP, MESSENGER, ...
- waMessageId
+ externalMessageId     string    // Platform message ID (WA mid or Messenger mid)
  direction
  body
  messageType
  status
  senderName
  metadata
  createdAt

  INDEX(conversationId, createdAt)
  INDEX(externalMessageId)         // For delivery receipt correlation
  INDEX(tenantId)
```

### 4.4 Modified: ChatbotFlow

```
ChatbotFlow (changes highlighted)
  id
  tenantId
  name
  description
  isActive
+ channel              enum: WHATSAPP, MESSENGER, ALL   // Which channel this flow serves
  nodes                JSON
  edges                JSON
  createdAt
  updatedAt

  INDEX(tenantId, channel, isActive)
```

The `channel` field on ChatbotFlow supports the dual-mode requirement (see Section 6). When set to `ALL`, the flow applies regardless of channel. When set to a specific channel, it only activates for that channel.

### 4.5 New: TenantChannelConfig

```
TenantChannelConfig
  id              PK
  tenantId        FK -> Tenant
  botFlowMode     enum: UNIFIED, PER_CHANNEL
  createdAt       timestamp
  updatedAt       timestamp

  UNIQUE(tenantId)
```

This is a lightweight per-tenant setting that controls whether bot flow routing is unified or channel-specific.

### 4.6 Entity Relationship Summary

```
Tenant
  |-- 1:N ChannelAccount        (WA line, Messenger page, etc.)
  |-- 1:1 TenantChannelConfig   (bot flow routing mode)
  |-- 1:N ChatbotFlow           (with channel scope: ALL, WHATSAPP, MESSENGER)
  |-- 1:N Conversation          (each tied to a specific channel + channelAccount)
  |       |-- 1:N Message       (each carries channel + externalMessageId)
  |-- 1:N User (agents)
  |-- 1:1 CopilotConfig
```

---

## 5. Message Flow: End to End

### 5.1 Inbound: Customer sends a message

```
Step 1: WEBHOOK RECEIPT
  Meta platform delivers POST /api/webhook
  Payload structure differs:
    WhatsApp: { object: "whatsapp_business_account", entry: [{ changes: [...] }] }
    Messenger: { object: "page", entry: [{ messaging: [...] }] }

Step 2: PLATFORM DETECTION
  Webhook handler iterates InboundAdapters:
    whatsAppAdapter.canHandle(body) -> checks body.object === "whatsapp_business_account"
    messengerAdapter.canHandle(body) -> checks body.object === "page"
  First match wins.

Step 3: SIGNATURE VERIFICATION
  Each adapter knows its signature scheme:
    WhatsApp: HMAC-SHA256 with app secret
    Messenger: HMAC-SHA256 with app secret (same Meta app, same secret)

Step 4: TENANT RESOLUTION
  Adapter extracts channelAccountId (phoneNumberId or pageId)
  Query: ChannelAccount WHERE externalId = ? AND channel = ?
  Retrieve associated tenantId

Step 5: MESSAGE NORMALIZATION
  Adapter converts platform payload to NormalizedInboundMessage:
    { channel, channelAccountId, senderId, content: { type, text, ... } }

Step 6: ENQUEUE
  Add to BullMQ "incoming-messages" queue:
    { tenantId, channelAccountId, channel, normalizedMessage }
  Return HTTP 200 immediately

Step 7: INCOMING WORKER PROCESSES
  Dequeue job
  Idempotency check: Message WHERE externalMessageId = ?
  Find open conversation: WHERE tenantId AND channelAccountId AND customerExternalId AND status != CLOSED
  Or create new conversation with channel metadata
  Store message with channel + externalMessageId
  Publish events: message:new, conversation:updated (include channel in event payload)

Step 8: BOT FLOW ROUTING
  If no agent assigned and not handed over:
    Check tenant's TenantChannelConfig.botFlowMode:
      UNIFIED  -> find active ChatbotFlow WHERE tenantId AND channel = ALL
      PER_CHANNEL -> find active ChatbotFlow WHERE tenantId AND channel = <this channel>
    Execute flow (channel-agnostic graph traversal)
    When flow needs to send a message -> enqueue to outgoing-messages with channelAccountId
```

### 5.2 Outbound: Bot or agent sends a reply

```
Step 1: MESSAGE CREATION
  Source: Agent via API, or Chatbot Engine
  Create Message record with:
    channel (inherited from conversation)
    channelAccountId (inherited from conversation)
    status: PENDING

Step 2: ENQUEUE
  Add to BullMQ "outgoing-messages" queue:
    { messageId, tenantId, channelAccountId, channel, recipientExternalId, content }

Step 3: OUTGOING WORKER
  Dequeue job
  Resolve ChannelAccount -> get credentials (accessToken, etc.)
  Select OutboundAdapter by channel type:
    WHATSAPP -> WhatsAppOutboundAdapter
    MESSENGER -> MessengerOutboundAdapter
  Call adapter.sendMessage(credentials, recipientId, content)
    WhatsApp: POST graph.facebook.com/{phoneNumberId}/messages { messaging_product: "whatsapp", ... }
    Messenger: POST graph.facebook.com/me/messages { recipient: { id: PSID }, message: { ... } }
  Update Message.externalMessageId and status
  Publish message:status event

Step 4: DELIVERY RECEIPTS
  Platform sends status webhook
  Webhook handler detects platform, normalizes status update
  Look up Message by externalMessageId
  Update status (sent -> delivered -> read)
  Publish message:status event -> Socket.IO -> Frontend updates ticks
```

### 5.3 Sequence Diagram: Full Lifecycle

```
Customer          Meta Platform       Webhook Svc        Queue       Worker         DB          Agent UI
   |                   |                  |                |           |             |              |
   |-- Send msg ------>|                  |                |           |             |              |
   |                   |-- POST /webhook->|                |           |             |              |
   |                   |                  |-- detect       |           |             |              |
   |                   |                  |   platform     |           |             |              |
   |                   |                  |-- resolve      |           |             |              |
   |                   |                  |   tenant       |           |             |              |
   |                   |                  |-- normalize -->|           |             |              |
   |                   |<---- 200 --------|   & enqueue    |           |             |              |
   |                   |                  |                |-- dequeue>|             |              |
   |                   |                  |                |           |-- upsert -->|              |
   |                   |                  |                |           |   conv+msg  |              |
   |                   |                  |                |           |-- event ----|---> update-->|
   |                   |                  |                |           |             |   (Socket.IO)|
   |                   |                  |                |           |-- bot flow->|              |
   |                   |                  |                |           |   (if no    |              |
   |                   |                  |                |           |    agent)   |              |
   |                   |                  |                |           |             |              |
   |                   |                  |                |           |             |   Agent sees |
   |                   |                  |                |           |             |   msg with   |
   |                   |                  |                |           |             |   channel    |
   |                   |                  |                |           |             |   badge      |
   |                   |                  |                |           |             |              |
   |                   |                  |                |           |             |<-- reply ----|
   |                   |                  |                |<----------|-- enqueue   |              |
   |                   |                  |                |-- dequeue>|             |              |
   |                   |                  |                |           |-- select    |              |
   |                   |                  |                |           |   adapter   |              |
   |                   |<----- API call --|----------------|-----------|             |              |
   |<-- Deliver msg ---|                  |                |           |             |              |
```

---

## 6. Tenant Configuration: Dual-Mode Bot Flows

### The Two Modes

Each tenant chooses one of two bot flow routing strategies via `TenantChannelConfig.botFlowMode`:

#### Mode A: PER_CHANNEL (Platform-specific flows)

```
Tenant: "AcmeCorp"
  botFlowMode: PER_CHANNEL

  ChatbotFlows:
    - "WhatsApp Welcome Flow"   channel=WHATSAPP   isActive=true
    - "Messenger Welcome Flow"  channel=MESSENGER   isActive=true

  Behavior:
    WhatsApp message arrives  -> runs "WhatsApp Welcome Flow"
    Messenger message arrives -> runs "Messenger Welcome Flow"
```

Use case: Different customer demographics per channel. WhatsApp might serve Hebrew-speaking customers with a Hebrew flow; Messenger might serve English-speaking customers.

#### Mode B: UNIFIED (Shared flow across channels)

```
Tenant: "GlobalShop"
  botFlowMode: UNIFIED

  ChatbotFlows:
    - "Universal Welcome Flow"  channel=ALL   isActive=true

  Behavior:
    WhatsApp message arrives  -> runs "Universal Welcome Flow"
    Messenger message arrives -> runs "Universal Welcome Flow"
```

Use case: Same brand experience regardless of channel. The flow is channel-agnostic; the outbound adapter handles format differences.

### Flow Selection Logic (Pseudocode)

```
function selectBotFlow(tenantId, channel):
  config = TenantChannelConfig.find(tenantId)

  if config.botFlowMode == PER_CHANNEL:
    flow = ChatbotFlow.find(tenantId, channel, isActive=true)
    if not flow:
      flow = ChatbotFlow.find(tenantId, channel=ALL, isActive=true)  // fallback
    return flow

  if config.botFlowMode == UNIFIED:
    return ChatbotFlow.find(tenantId, channel=ALL, isActive=true)
```

### Admin UI for Mode Selection

The tenant admin settings page gets a new section:

```
Bot Flow Routing
  ( ) Unified - Same flow for all channels
  (x) Per Channel - Different flow per channel

  [If Per Channel is selected:]
  WhatsApp Flow:  [dropdown: select flow]
  Messenger Flow: [dropdown: select flow]

  [If Unified is selected:]
  Active Flow:    [dropdown: select flow]
```

### Flow Editor Enhancement

The flow editor already supports a channel-agnostic graph (nodes + edges). The only change needed:
- Add a `channel` selector when creating/editing a flow: "WhatsApp only", "Messenger only", or "All channels"
- When a flow targets a specific channel, show a hint about platform-specific capabilities (e.g., "WhatsApp supports up to 3 quick reply buttons; Messenger supports up to 13")

---

## 7. UI / Agent Experience

### 7.1 Unified Inbox

The conversation list shows a **channel badge** next to each conversation:

```
+----------------------------------------------+
| Conversations                    [Filter: All v] |
+----------------------------------------------+
| [WA] Ahmed Al-Farsi              2m ago      |
|     "I need help with my order"              |
+----------------------------------------------+
| [MSG] Sarah Johnson              5m ago      |
|     "When does the sale start?"              |
+----------------------------------------------+
| [WA] David Cohen                 12m ago     |
|     [Image]                                  |
+----------------------------------------------+
```

**Channel filter**: Agents can filter the inbox by channel: All / WhatsApp / Messenger. This is a client-side filter on the `channel` field already present on every conversation.

### 7.2 Chat Panel

The chat header shows the channel context:

```
+---------------------------------------------------+
| [WA icon] Ahmed Al-Farsi                          |
| WhatsApp  +972-50-XXX-XXXX        [Claim] [Close] |
+---------------------------------------------------+
| ...messages...                                     |
+---------------------------------------------------+
| [Type a message...]                    [Send]      |
+---------------------------------------------------+
```

For Messenger:
```
+---------------------------------------------------+
| [MSG icon] Sarah Johnson                          |
| Messenger                          [Claim] [Close] |
+---------------------------------------------------+
```

**Agent experience**:
- The agent types a reply in the same text box regardless of channel
- The system automatically routes the reply through the correct platform
- The agent does NOT need to think about which API to use
- Channel-specific constraints (e.g., WhatsApp 24-hour window) are surfaced as inline warnings when relevant

### 7.3 Socket.IO Events (Enhanced)

All existing events (`message:new`, `conversation:updated`, etc.) now include the `channel` field in their payload. The frontend uses this to:
- Render the correct channel icon
- Apply channel-specific styling (green tint for WA, blue for Messenger)
- Show channel-appropriate status indicators

### 7.4 CoPilot Panel

The AI CoPilot receives channel context in its prompts:

```
System: "The customer is contacting via {channel}. Adjust your suggestions
         for this platform's capabilities and conventions."
```

This allows the AI to suggest appropriate response formats (e.g., not suggesting template messages for Messenger conversations).

---

## 8. Extensibility Strategy

### 8.1 Adding a New Channel (e.g., Instagram)

Adding Instagram DM support requires exactly **four implementation tasks**:

```
1. InstagramInboundAdapter   implements InboundAdapter
   - canHandle(): body.object === "instagram"
   - extractMessages(): parse Instagram messaging webhook format
   - resolveChannelAccountId(): extract IG business account ID

2. InstagramOutboundAdapter  implements OutboundAdapter
   - sendTextMessage(): POST to Instagram Send API
   - sendInteractiveMessage(): map to Instagram-supported interactive formats
   - mapCapabilities(): handle IG-specific limitations

3. ChannelRegistry entry
   - Register INSTAGRAM channel type
   - Define supported message types and constraints

4. Database migration
   - Add INSTAGRAM to channel enum
   - No schema changes needed -- ChannelAccount already supports arbitrary channels
```

**No changes needed in**: Incoming worker, conversation service, chatbot engine, agent UI, event bus, analytics, auth, or any core business logic.

### 8.2 Adding Non-Meta Channels (e.g., Telegram, SMS)

Non-Meta channels require a separate webhook endpoint but use the same architecture:

```
POST /api/webhook/telegram   -> TelegramInboundAdapter -> same normalized model -> same queue
POST /api/webhook/sms        -> SmsInboundAdapter      -> same normalized model -> same queue
```

The webhook gateway gains a simple router:
```
/api/webhook         -> Meta webhook (WA + Messenger + Instagram)
/api/webhook/telegram -> Telegram webhook
/api/webhook/sms      -> SMS provider webhook (Twilio, etc.)
```

Everything downstream remains identical.

### 8.3 Cross-Channel Customer Identity (Future)

Currently, each channel creates independent conversations. A customer who contacts via both WhatsApp and Messenger appears as two separate customers.

**Future enhancement**: A `CustomerIdentity` model that links channel-specific identifiers to a unified customer profile:

```
CustomerProfile
  id
  tenantId
  displayName
  metadata

CustomerChannelIdentity
  id
  customerProfileId   FK -> CustomerProfile
  channel             WHATSAPP | MESSENGER | ...
  externalId          phone number | PSID | ...

  UNIQUE(channel, externalId)
```

This enables:
- Viewing all conversations with a customer across channels in one panel
- Agent context: "This customer also contacted us via WhatsApp yesterday"
- Analytics: unified customer journey across channels

**This is intentionally deferred** -- it adds complexity and is not required for the initial omnichannel rollout. The architecture supports it without breaking changes.

### 8.4 Channel Capability Matrix

The system maintains a capability matrix that the chatbot engine and UI consult:

```
                    WhatsApp    Messenger   Instagram   (future)
Text message          yes         yes         yes
Image                 yes         yes         yes
Quick reply buttons   3 max       13 max      varies
List messages         yes         no          no
Template messages     yes         no          no
Typing indicator      no          yes         yes
Read receipts         yes         yes         no
Persistent menu       no          yes         no
```

The chatbot engine uses this to:
- Validate flows at design time (warn about unsupported features)
- Gracefully degrade at runtime (fall back to text when interactive format is unsupported)

---

## 9. Migration Path

### Phase 1: Introduce Abstraction Layer (No New Channels Yet)

1. Create `ChannelAccount` model
2. Migrate existing WA credentials from `Tenant` to `ChannelAccount` rows
3. Add `channel`, `channelAccountId`, `customerExternalId` to `Conversation` (backfill existing as WHATSAPP)
4. Rename `waMessageId` to `externalMessageId` on `Message` (backfill existing)
5. Extract `WhatsAppInboundAdapter` and `WhatsAppOutboundAdapter` from current hardcoded logic
6. Update webhook to use adapter pattern
7. Update incoming/outgoing workers to use normalized message model
8. Update chatbot engine to send via adapter instead of direct WA API calls

**Result**: System works exactly as before, but with proper abstraction. All tests pass. No user-facing changes.

### Phase 2: Add Messenger Support

1. Implement `MessengerInboundAdapter` and `MessengerOutboundAdapter`
2. Add Messenger to channel enum
3. Build ChannelAccount admin UI (add/manage Messenger pages)
4. Build bot flow mode selector (unified vs per-channel)
5. Add channel badge to conversation list and chat panel
6. Add channel filter to inbox

**Result**: Tenants can connect Messenger pages and receive/respond to Messenger conversations alongside WhatsApp.

### Phase 3: Polish and Extend

1. Cross-channel customer identity linking
2. Channel-specific analytics dashboards
3. Instagram DM support
4. Channel capability validation in flow editor

---

## Summary: Component Responsibility Matrix

| Component | Knows About Channels? | Responsibility |
|-----------|----------------------|----------------|
| Webhook Gateway | YES | Detect platform, delegate to adapter |
| Inbound Adapters | YES (one channel each) | Parse platform payload -> normalized model |
| Outbound Adapters | YES (one channel each) | Normalized model -> platform API call |
| Channel Registry | YES | Define channel capabilities and constraints |
| ChannelAccount Model | YES | Store per-channel credentials per tenant |
| Incoming Worker | NO | Process normalized messages, manage conversations |
| Conversation Service | MINIMAL (stores channel as metadata) | CRUD, real-time events, agent assignment |
| Chatbot Engine | NO (sends via adapter interface) | Execute flow graph, channel-agnostic |
| AI CoPilot | MINIMAL (receives channel as context) | Suggestions, summaries, intent |
| Agent UI | DISPLAY ONLY (channel badge/icon) | Unified inbox, reply routing is automatic |
| Analytics | DIMENSION ONLY (channel as a filter) | Track metrics, channel is a dimension |
| Auth / RBAC | NO | Tenant/user management, unchanged |

This architecture ensures that adding a new channel is a **bounded, isolated task** that never requires changes to core business logic, the chatbot engine, or the agent experience.
