# GOTCHA AI Studio — Product Requirements Document

**Version:** 1.0
**Date:** 2026-03-13
**Status:** Design Phase

---

## Executive Summary

GOTCHA AI Studio is a unified workspace where businesses configure everything related to AI behavior — agents, conversation flows, routing, knowledge, and tools — from one place. The experience is designed for non-technical business owners, inspired by the simplicity of Notion, the visual power of n8n, and the automation clarity of Zapier.

---

## Product Architecture

```
+------------------------------------------------------------------+
|                        AI STUDIO                                  |
|                                                                   |
|  +------------+  +----------+  +--------+  +-----------+         |
|  |   Agents   |  |  Flows   |  | Router |  | Knowledge |         |
|  +------------+  +----------+  +--------+  +-----------+         |
|                                                                   |
|  +-------------------+  +------------------+                      |
|  | Tools/Integrations|  | Interactive Msgs |                      |
|  +-------------------+  +------------------+                      |
+------------------------------------------------------------------+
         |                    |                    |
    +---------+         +---------+          +---------+
    | WhatsApp|         |Instagram|          |Web Chat |
    +---------+         +---------+          +---------+
         |                    |                    |
         +--------------------+--------------------+
                              |
                       +-------------+
                       |   Inbox     |
                       | (Co-Pilot)  |
                       +-------------+
```

### How Components Interact

1. **Message arrives** from any channel (WhatsApp, Instagram, Web Chat)
2. **AI Router** evaluates the message — determines intent, checks rules
3. Router sends the conversation to one of:
   - An **AI Agent** (autonomous handling)
   - A **Flow** (structured step-by-step)
   - A **Human Agent** (with optional Co-Pilot assist)
4. The agent/flow uses **Tools** to interact with external systems
5. The agent/flow references **Knowledge** to answer questions
6. Responses can include **Interactive Messages** (buttons, quick replies)
7. Everything is configured inside **AI Studio**

---

## 1. AI Studio (Main Workspace)

### What It Is

AI Studio is the central hub where all AI behavior is configured. It replaces the current fragmented setup (separate copilot configs, bot flows, department settings) with one unified workspace.

### Problem It Solves

Today, configuring AI in GOTCHA requires navigating multiple pages — copilot settings per department, bot flow mode, knowledge base settings. A business owner cannot easily understand "what does my AI do?" AI Studio answers that question in one screen.

### UX Design

**Layout:** Dashboard with 5 tabs across the top:

```
[ Agents ]  [ Flows ]  [ Router ]  [ Knowledge ]  [ Tools ]
```

**Dashboard View (Home):**

| Section | Display |
|---------|---------|
| Active Agents | Cards showing each agent with status dot, assigned channels, conversation count |
| Active Flows | List of flows with trigger info and on/off toggle |
| Router Status | Visual showing current routing rules |
| Knowledge | Source count with sync status indicators |
| Tools | Connected integrations count |

**Key UX Principles:**
- No code anywhere
- Every setting has a plain-language description
- Preview/test button on every component
- Changes save automatically (like Notion)
- Undo support for all changes

### Configuration

Users access AI Studio from the main sidebar navigation. The sidebar item replaces the current separate "Copilot" and "Bot" entries.

### Definition of Done

- [ ] Single sidebar entry "AI Studio" replaces Copilot/Bot pages
- [ ] Dashboard shows health overview of all AI components
- [ ] All 5 tabs functional and navigable
- [ ] Auto-save on all configuration changes
- [ ] Activity log showing recent AI configuration changes
- [ ] Mobile-responsive layout
- [ ] Onboarding wizard for first-time setup

---

## 2. AI Agents

### What It Is

Agents are AI personas that represent roles in the business. Each agent has a specific purpose, personality, set of skills (tools), and knowledge.

### Problem It Solves

Currently GOTCHA has a single AI behavior configured per department. Businesses need multiple specialized AI personas — a support agent that's empathetic and careful, a sales agent that's enthusiastic and proactive, a booking agent that's efficient and structured.

### UX Design

**Agent List View:**
Cards in a grid layout. Each card shows:
- Agent avatar (auto-generated or uploaded)
- Agent name ("Maya — Support Agent")
- Status badge (Active / Draft / Paused)
- Quick stats: conversations handled today, satisfaction score
- Edit / Duplicate / Delete actions

**Agent Editor — Form-Based, Not Prompt-Based:**

Instead of a raw text prompt, users configure agents through structured sections:

```
+------------------------------------------+
| Agent Setup                              |
+------------------------------------------+
| Name:        [Maya                     ] |
| Role:        [Customer Support Agent   ] |
| Description: [Handles support queries  ] |
+------------------------------------------+

+------------------------------------------+
| Personality                              |
+------------------------------------------+
| Tone:     [ ] Professional               |
|           [x] Friendly                   |
|           [ ] Casual                     |
|           [ ] Formal                     |
|                                          |
| Language: [x] English  [x] Hebrew       |
|                                          |
| Style:    [x] Use emojis occasionally   |
|           [x] Keep responses concise    |
|           [ ] Use customer's first name |
+------------------------------------------+

+------------------------------------------+
| Skills (Tools)                           |
+------------------------------------------+
| [x] Order Lookup (Shopify)               |
| [x] Track Shipment (Shopify)             |
| [ ] Process Refund (Shopify) — HIGH RISK |
| [x] Customer Lookup (HubSpot)            |
| [+] Add more tools...                   |
+------------------------------------------+

+------------------------------------------+
| Knowledge                               |
+------------------------------------------+
| [x] FAQ — General Support               |
| [x] Return Policy Document              |
| [x] Product Catalog                     |
| [+] Add knowledge source...             |
+------------------------------------------+

+------------------------------------------+
| Escalation Rules                         |
+------------------------------------------+
| Escalate to human when:                  |
| [x] Customer asks to speak to a human   |
| [x] Customer is angry (detected)        |
| [x] After 3 failed attempts             |
| [x] Refund amount exceeds $100          |
| [ ] Always for VIP customers            |
| [+] Add rule...                         |
+------------------------------------------+

+------------------------------------------+
| Channels                                 |
+------------------------------------------+
| Active on:                               |
| [x] WhatsApp — Main Number              |
| [x] Instagram — @gotchastore            |
| [ ] Web Chat                            |
+------------------------------------------+
```

**Test Panel (right side):**
A live chat simulator where the user can test the agent's behavior before publishing.

### Configuration

1. Click "+ New Agent" from the Agents tab
2. Fill in the form sections
3. Test in the simulator
4. Toggle "Active" to deploy

### Definition of Done

- [ ] Agent list view with cards showing name, role, status, stats
- [ ] Form-based agent editor with all sections above
- [ ] Personality configured via checkboxes and dropdowns (not raw prompts)
- [ ] Tool assignment with risk-level warnings
- [ ] Knowledge source assignment
- [ ] Escalation rules builder with conditions
- [ ] Channel assignment per agent
- [ ] Live test simulator panel
- [ ] Agent duplication
- [ ] Agent versioning (see previous configurations)
- [ ] Conversation handoff between agents

---

## 3. Conversation Flow Builder

### What It Is

A visual drag-and-drop flow builder where users create structured conversation paths. Flows combine hard logic (fixed steps) with AI intelligence (dynamic responses).

### Problem It Solves

Some conversations need structure — onboarding sequences, lead qualification, appointment booking. Pure AI is too unpredictable for these. Pure scripted flows are too rigid. The Flow Builder lets users combine both.

### UX Design

**Canvas-based visual editor** (similar to n8n/ManyChat):

```
[Trigger: New Conversation]
        |
        v
[Send Message: "Hi! How can I help?"]
        |
        v
[Quick Reply Buttons]
  |         |          |
  v         v          v
[Order]  [Returns]  [Other]
  |         |          |
  v         v          v
[AI Agent: [Flow:     [AI Agent:
 Support]   Returns]   General]
```

**Available Node Types:**

| Node | Icon | Description |
|------|------|-------------|
| **Send Message** | Chat bubble | Send a text, image, or file |
| **Quick Reply** | Buttons | Present clickable options to the customer |
| **Condition** | Diamond | Branch based on a condition (time, customer attribute, keyword) |
| **AI Agent** | Brain | Hand off to an AI agent for dynamic conversation |
| **Tool Call** | Wrench | Execute a tool (check order, book appointment) |
| **Wait** | Clock | Pause for customer response or a time delay |
| **Human Escalation** | Person | Transfer to a human agent |
| **Set Variable** | Tag | Store data for use later in the flow |
| **HTTP Request** | Globe | Call an external API |
| **Note** | Sticky note | Internal annotation (not sent to customer) |

**Node Configuration (sidebar panel when node is selected):**

Example for "Send Message" node:
```
+----------------------------------+
| Send Message                     |
+----------------------------------+
| Message:                         |
| [Hi {{customer.firstName}}!    ] |
| [How can I help you today?     ] |
|                                  |
| Attachments:                     |
| [+ Add image/file]              |
|                                  |
| Delay before sending: [0] sec   |
+----------------------------------+
```

Example for "Condition" node:
```
+----------------------------------+
| Condition                        |
+----------------------------------+
| If:                              |
| [Customer Tag] [equals] [VIP]   |
|                                  |
| Then: → (green path)            |
| Else: → (gray path)             |
+----------------------------------+
```

**Flow Templates:**
Pre-built templates users can start from:
- Welcome & Onboarding
- Lead Qualification
- Order Status Check
- Appointment Booking
- Feedback Collection
- FAQ Routing

### Configuration

1. Go to Flows tab → "+ New Flow"
2. Choose blank or template
3. Drag nodes from the left panel onto the canvas
4. Connect nodes by dragging between ports
5. Click a node to configure it in the right panel
6. Set a trigger (new conversation, keyword, router assignment)
7. Test with the built-in simulator
8. Toggle Active

### Definition of Done

- [ ] Visual canvas with drag-and-drop nodes
- [ ] All 10 node types functional
- [ ] Node configuration via side panel
- [ ] Variable system ({{customer.name}}, {{order.status}})
- [ ] Flow templates library (at least 5)
- [ ] Built-in flow simulator/tester
- [ ] Flow versioning and rollback
- [ ] Flow analytics (drop-off rates per node)
- [ ] Import/export flows as JSON
- [ ] Conditional branching with AND/OR logic
- [ ] Sub-flow support (flow within a flow)
- [ ] Error handling nodes (what happens when a tool call fails)

---

## 4. AI Router

### What It Is

The AI Router is the intelligent traffic controller that decides what happens when a new message arrives. It evaluates the message and routes it to the right handler.

### Problem It Solves

Currently routing is basic — either everything goes to AI or everything goes to human agents. Businesses need smart routing: sales inquiries to the sales agent, support issues to the support agent, VIP customers directly to humans, after-hours to a specific flow.

### UX Design

**Visual Rules List** (priority-ordered, top to bottom):

```
+----------------------------------------------------------+
| AI Router                                                 |
+----------------------------------------------------------+
| Rules are evaluated top to bottom. First match wins.     |
|                                                          |
| Priority | Rule                        | Route To       |
| -------- | --------------------------- | -------------- |
| 1        | VIP customers               | Human Agent    |
| 2        | Intent: "cancel order"      | Returns Flow   |
| 3        | Intent: "track order"       | Support Agent  |
| 4        | Intent: "pricing/buy"       | Sales Agent    |
| 5        | After business hours        | After-Hours    |
| 6        | Everything else             | General Agent  |
|                                                          |
| [+ Add Rule]                                             |
+----------------------------------------------------------+
```

**Rule Editor (when clicking a rule):**

```
+------------------------------------------+
| Edit Rule                                |
+------------------------------------------+
| Name: [VIP Direct to Human            ] |
|                                          |
| When:                                    |
| [Customer Tag] [equals] [VIP]           |
| [+ Add condition]                       |
|                                          |
| Logic: (x) All conditions match (AND)   |
|        ( ) Any condition matches (OR)   |
|                                          |
| Route to:                                |
| ( ) AI Agent → [dropdown]              |
| ( ) Flow → [dropdown]                  |
| (x) Human Agent                        |
|     Department: [Support Team]          |
|                                          |
| [Save]  [Delete]                        |
+------------------------------------------+
```

**Available Conditions:**

| Condition Type | Examples |
|---------------|----------|
| AI Intent | "track order", "complaint", "pricing question" |
| Keywords | Contains "urgent", "refund", "cancel" |
| Customer Attribute | Tag = VIP, Country = US, Language = Hebrew |
| Channel | WhatsApp, Instagram, Web Chat |
| Time | Business hours, After hours, Weekend |
| Conversation History | Returning customer, First conversation |
| Sentiment | Angry, Neutral, Happy (AI-detected) |

### Configuration

1. Go to Router tab
2. Rules are listed in priority order
3. Click "+ Add Rule" to create new
4. Drag to reorder priority
5. Each rule has conditions (left) and destination (right)
6. Default fallback rule at the bottom (cannot be deleted)

### Definition of Done

- [ ] Visual priority-ordered rules list
- [ ] Drag-to-reorder rules
- [ ] Rule editor with condition builder
- [ ] AI intent detection as a condition type
- [ ] Keyword matching conditions
- [ ] Customer attribute conditions
- [ ] Time-based conditions (business hours)
- [ ] Channel-based routing
- [ ] Sentiment-based routing
- [ ] Default fallback rule
- [ ] Rule testing/simulation
- [ ] Router analytics (which rules fire most often)

---

## 5. Tools & Integrations

### What It Is

Tools are actions that AI agents can perform by connecting to external systems. Integrations are the connections to those systems. An integration (e.g., Shopify) provides multiple tools (order lookup, track shipment, process refund).

### Problem It Solves

AI agents need to do more than just chat — they need to check orders, look up customer data, book appointments, process refunds. Tools bridge the gap between conversation and action.

### UX Design

**Already implemented** in the current Integrations Marketplace (`/integrations`). The existing design includes:

- Marketplace grid with brand logos, categories, and auth type badges
- Detail page with connection form (API Key / OAuth)
- Tool toggles per integration
- Risk level badges on tools

**Enhancements for AI Studio integration:**

Within the AI Studio Tools tab, show a simplified view:

```
+----------------------------------------------------------+
| Connected Tools                                           |
+----------------------------------------------------------+
| Shopify (Connected)                                       |
|   [x] Order Lookup         LOW risk    Used by: Maya     |
|   [x] Track Shipment       LOW risk    Used by: Maya     |
|   [ ] Process Refund       HIGH risk   Not assigned      |
|   [x] Cancel Order         HIGH risk   Used by: Maya     |
|                                                          |
| HubSpot (Connected)                                       |
|   [x] Customer Lookup      LOW risk    Used by: All      |
|   [x] Create Deal          MEDIUM risk Used by: Sales    |
|                                                          |
| PostgreSQL (Connected)                                    |
|   [x] Run Query            MEDIUM risk Used by: Maya     |
|   [x] List Tables          LOW risk    Used by: Maya     |
|                                                          |
| [+ Connect New Integration]  → opens /integrations       |
+----------------------------------------------------------+
```

**Tool Execution Log:**
A live feed showing which tools were called, by which agent, with what result:

```
| Time  | Agent | Tool              | Result  | Duration |
|-------|-------|-------------------|---------|----------|
| 14:32 | Maya  | Order Lookup      | Success | 1.2s     |
| 14:30 | Sales | Customer Lookup   | Success | 0.8s     |
| 14:28 | Maya  | Track Shipment    | Failed  | 3.1s     |
```

### Configuration

1. Connect integrations from the Marketplace (`/integrations`)
2. In AI Studio → Tools tab, see all connected tools
3. Assign tools to agents from either the Tools tab or the Agent editor
4. Monitor tool usage from the execution log

### Definition of Done

- [x] Integration marketplace with brand logos
- [x] OAuth and API Key connection flows
- [x] Tool enable/disable toggles
- [x] Risk level badges
- [x] Category filters
- [ ] Tool assignment to specific agents (from AI Studio)
- [ ] Tool execution log with success/failure tracking
- [ ] Tool usage analytics per agent
- [ ] Tool rate limiting configuration
- [ ] Tool approval workflow for HIGH risk tools
- [ ] Custom tool builder (define your own API tool)

---

## 6. Knowledge Sources

### What It Is

Knowledge Sources are the information AI agents reference when answering questions. They include documents, FAQs, websites, and structured data that agents can search and cite.

### Problem It Solves

AI agents need accurate, up-to-date information about the business. Without knowledge sources, agents hallucinate or give generic answers. With them, agents can answer "What's your return policy?" accurately by referencing the actual policy document.

### UX Design

**Knowledge Library View:**

```
+----------------------------------------------------------+
| Knowledge Sources                                         |
+----------------------------------------------------------+
| [+ Add Source]                                            |
|                                                          |
| Source              | Type     | Status  | Last Synced   |
| ------------------- | -------- | ------- | ------------- |
| Return Policy       | Document | Synced  | 2 hours ago   |
| FAQ - General       | FAQ      | Synced  | 1 hour ago    |
| Product Catalog     | Website  | Syncing | In progress   |
| Help Center         | Website  | Synced  | 30 min ago    |
| Shipping Rates.pdf  | File     | Synced  | Yesterday     |
+----------------------------------------------------------+
```

**Add Source Dialog:**

```
+------------------------------------------+
| Add Knowledge Source                     |
+------------------------------------------+
| Type:                                    |
| [x] Upload Files (PDF, DOCX, TXT, MD)  |
| [ ] Website URL (auto-crawl)           |
| [ ] FAQ (structured Q&A pairs)         |
| [ ] Notion Page                        |
| [ ] Google Docs                        |
| [ ] Plain Text                         |
|                                          |
| [Choose files or paste URL...]          |
|                                          |
| Auto-sync: [x] Daily  [ ] Weekly       |
|                                          |
| [Upload & Process]                      |
+------------------------------------------+
```

**FAQ Editor (for structured Q&A):**

```
+------------------------------------------+
| FAQ: General Support                     |
+------------------------------------------+
| Q: What is your return policy?           |
| A: We accept returns within 30 days...   |
|                                          |
| Q: How long does shipping take?          |
| A: Standard shipping takes 3-5 days...   |
|                                          |
| Q: Do you ship internationally?          |
| A: Yes, we ship to 50+ countries...      |
|                                          |
| [+ Add Question]                        |
+------------------------------------------+
```

### Configuration

1. Go to Knowledge tab → "+ Add Source"
2. Choose source type
3. Upload file / paste URL / write Q&A
4. System automatically processes and indexes
5. Assign knowledge sources to agents

### Definition of Done

- [x] File upload (PDF, DOCX, TXT, MD)
- [x] Basic knowledge base per department
- [ ] Website URL crawling with auto-sync
- [ ] Structured FAQ editor with Q&A pairs
- [ ] Notion/Google Docs integration
- [ ] Knowledge source assignment to specific agents
- [ ] Sync status and freshness indicators
- [ ] Knowledge preview (see what the AI "knows")
- [ ] Knowledge gap detection (common questions without answers)
- [ ] Source citation in AI responses ("Based on Return Policy doc...")
- [ ] Auto-sync scheduling (daily/weekly)

---

## 7. Co-Pilot Mode

### What It Is

Co-Pilot is the AI assistance mode for human agents working in the inbox. It provides real-time suggestions, draft replies, and contextual information while the human stays in control.

### Problem It Solves

Even with AI agents, many conversations require human handling. Co-Pilot makes human agents faster and more consistent by providing AI-drafted replies, relevant knowledge, and customer context — without taking over the conversation.

### UX Design

**Three Modes (configurable per department/agent):**

| Mode | Behavior |
|------|----------|
| **Human Only** | No AI involvement. Agent types every reply manually. |
| **Co-Pilot** | AI drafts replies, suggests knowledge, surfaces customer context. Human reviews and sends. |
| **Autonomous** | AI handles the conversation independently. Human can monitor and intervene. |

**Co-Pilot Panel in Inbox (right side of conversation):**

```
+------------------------------------------+
| Co-Pilot                                |
+------------------------------------------+
| Suggested Reply:                         |
| "Hi Sarah! I checked your order          |
| #12345 — it's currently in transit       |
| and should arrive by Thursday.           |
| Is there anything else I can help        |
| with?"                                   |
|                                          |
| Confidence: 94%                          |
| [Send as-is] [Edit & Send] [Dismiss]    |
+------------------------------------------+
| Customer Context:                        |
| Name: Sarah Johnson                      |
| Orders: 12 (VIP customer)               |
| Last order: #12345 — In Transit          |
| Sentiment: Neutral                       |
+------------------------------------------+
| Relevant Knowledge:                      |
| - Shipping takes 3-5 business days       |
| - Express upgrade available for $9.99    |
| Source: Shipping FAQ                     |
+------------------------------------------+
| Suggested Actions:                       |
| [Check Order Status]                     |
| [Offer Express Upgrade]                 |
| [Transfer to Shipping Team]             |
+------------------------------------------+
```

**Mode Switching:**
A toggle in the inbox header per conversation or department:

```
[ Human Only | Co-Pilot | Autonomous ]
                 ^^^
              (selected)
```

### Configuration

1. Default mode set per department in AI Studio
2. Can be overridden per conversation by the agent
3. Co-Pilot behavior configured through the agent's personality settings
4. Tool access in Co-Pilot controlled by agent tool assignments

### Definition of Done

- [x] Basic Co-Pilot panel with suggested replies
- [x] Three mode options (Human / Co-Pilot / Autonomous)
- [ ] Confidence score on suggestions
- [ ] Customer context panel (pulled from CRM/tools)
- [ ] Relevant knowledge display with source citation
- [ ] Suggested actions (one-click tool calls)
- [ ] Edit-before-send workflow
- [ ] Mode toggle per conversation
- [ ] Co-Pilot analytics (acceptance rate, edit rate)
- [ ] Learning from edits (improve suggestions over time)
- [ ] Multi-language support in suggestions

---

## 8. Interactive Messages

### What It Is

Interactive Messages are structured UI elements that AI agents and flows can send within conversations — buttons, quick replies, carousels, and forms that customers tap instead of typing.

### Problem It Solves

Free-text conversations are slow and error-prone. When a customer needs to choose between 3 options, showing buttons is faster and clearer than asking them to type. Interactive messages guide the conversation and reduce misunderstanding.

### UX Design

**Available Message Types:**

| Type | Description | Channel Support |
|------|-------------|-----------------|
| **Quick Reply Buttons** | Up to 3 text buttons below a message | WhatsApp, Instagram, Web |
| **List Menu** | Expandable list with sections and items | WhatsApp, Web |
| **Call-to-Action** | Buttons that open URLs or make phone calls | WhatsApp, Web |
| **Carousel** | Horizontal scrollable cards with images | Instagram, Web |
| **Form** | Structured input fields (name, email, etc.) | Web |

**Configuration in Flow Builder (Send Message node):**

```
+------------------------------------------+
| Send Message                             |
+------------------------------------------+
| Type: [Quick Reply Buttons]              |
|                                          |
| Message:                                 |
| [How can I help you today?            ]  |
|                                          |
| Buttons:                                 |
| [1] [Check my order      ] → Order Flow |
| [2] [Return an item      ] → Returns    |
| [3] [Something else      ] → AI Agent   |
|                                          |
| [+ Add Button] (max 3)                  |
+------------------------------------------+
```

**Configuration in Agent Settings:**

```
+------------------------------------------+
| Interactive Messages                     |
+------------------------------------------+
| Allow agent to send:                     |
| [x] Quick Reply Buttons                 |
| [x] Suggested Options                   |
| [ ] List Menus                          |
|                                          |
| Auto-suggest buttons when:              |
| [x] Multiple options are available      |
| [x] Yes/No question is detected         |
| [ ] Always (for every response)         |
+------------------------------------------+
```

### Configuration

1. In Flow Builder: select "Quick Reply" or "List" as message type in Send Message nodes
2. In Agent Settings: toggle which interactive formats the agent can auto-generate
3. The AI agent intelligently decides when to use buttons vs. plain text based on context

### Definition of Done

- [ ] Quick Reply Buttons in flows and AI responses
- [ ] List Menu support for WhatsApp
- [ ] Call-to-Action buttons (URL, phone)
- [ ] Carousel cards for Instagram/Web
- [ ] Web chat form inputs
- [ ] AI auto-detection of when to use buttons
- [ ] Channel-aware rendering (degrade gracefully)
- [ ] Button click tracking and analytics
- [ ] Flow Builder visual preview of interactive messages
- [ ] Template library for common interactive patterns

---

## Component Interaction Map

```
                    +-----------+
    Message In ---->|  ROUTER   |
                    +-----------+
                     /    |     \
                    /     |      \
            +------+ +------+ +-------+
            |AGENT | | FLOW | | HUMAN |
            +------+ +------+ +-------+
                |        |        |
            +------+  +------+ +--------+
            |TOOLS |  |TOOLS | |CO-PILOT|
            +------+  +------+ +--------+
                |        |        |
            +------+  +------+ +------+
            |KNOWL.|  |KNOWL.| |KNOWL.|
            +------+  +------+ +------+
                \        |       /
                 \       |      /
              +-------------------+
              | INTERACTIVE MSGS  |
              +-------------------+
                       |
                  Message Out
```

**Data Flow:**
1. Router reads customer attributes, intent, and rules
2. Agents/Flows read knowledge and call tools
3. Co-Pilot reads everything the agent would, but presents to human
4. Interactive messages are the output format for any handler
5. All execution is logged for analytics

---

## Implementation Priority

### Phase 1 — Foundation (Weeks 1-4)
- AI Studio shell with navigation tabs
- Agent editor (form-based, replacing current copilot config)
- Router with basic rules (intent + keyword)
- Knowledge sources migration (existing KB into new UI)

### Phase 2 — Flow Builder (Weeks 5-8)
- Visual canvas with core nodes (Send, Quick Reply, Condition, AI Agent)
- Flow templates (3 starter templates)
- Flow simulator/tester
- Interactive messages (Quick Reply Buttons)

### Phase 3 — Intelligence (Weeks 9-12)
- Advanced router conditions (sentiment, customer attributes)
- Co-Pilot enhancements (confidence scores, context panel)
- Tool execution logging and analytics
- Knowledge gap detection

### Phase 4 — Polish (Weeks 13-16)
- Flow analytics (drop-off rates)
- Agent versioning and rollback
- Custom tool builder
- Carousel and List Menu interactive messages
- Multi-agent handoff

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to configure first AI agent | < 5 minutes |
| Non-technical user can create a flow | Without documentation |
| AI resolution rate | > 60% of conversations |
| Co-Pilot suggestion acceptance rate | > 50% |
| Average routing accuracy | > 90% |
| Tool call success rate | > 95% |
| Knowledge answer accuracy | > 85% |

---

## Design Principles Summary

1. **No code.** Everything configurable through visual UI.
2. **Form over prompt.** Structured inputs, not free-text prompts.
3. **Progressive disclosure.** Simple by default, powerful when needed.
4. **Test before deploy.** Every component has a simulator.
5. **Undo everything.** All changes are reversible.
6. **Show, don't tell.** Visual previews over documentation.
7. **One workspace.** AI Studio is the single source of truth.
