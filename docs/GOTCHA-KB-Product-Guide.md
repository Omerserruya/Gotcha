# GOTCHA - Complete Product Knowledge Base

**Version:** 2.0
**Last Updated:** April 2026

---

## 1. What Is GOTCHA?

GOTCHA is the operating system for customer communication. It brings every customer conversation - from WhatsApp, Instagram, Facebook Messenger, Gmail, Outlook, Slack, and Web Chat - into a single unified inbox, and layers AI across every touchpoint: responding, routing, executing actions, and continuously learning.

GOTCHA is not just a communication platform - it is a system where conversations become actions, and actions drive business outcomes.

Where traditional platforms stop at messaging, GOTCHA goes further. The AI doesn't just suggest replies - it takes action. It updates CRM records, triggers workflows, segments audiences, and optimizes performance - all from a single conversational interface. Users can ask questions, execute operations, and build automations using natural language. No dashboards to navigate. No rules to configure manually. Just describe what you need, and GOTCHA makes it happen.

GOTCHA is **not** a chatbot that replaces human agents. It is an AI-augmented execution layer that empowers human agents with real-time suggestions, automated routing, instant access to the company's knowledge base, and the ability to act on business data - so they can focus on what matters most: the customer.

**Website:** https://gotcha.co.il

**Tagline:** "The OS for Customer Communication - AI that empowers your agents and turns every conversation into a growth engine."

---

## 2. Core Philosophy

Most customer communication platforms try to replace human agents with chatbots. GOTCHA takes the opposite approach - and goes much further than a traditional inbox.

- **AI works with agents, not instead of them.** The AI co-pilot reads conversations, understands context, and suggests replies - but the human always has the final say.
- **Conversations are execution triggers.** A message isn't just a message - it's a signal. GOTCHA treats every conversation as an opportunity to detect intent, take action, and drive outcomes.
- **From data to action, instantly.** Instead of navigating dashboards and exporting CSVs, users ask questions in natural language and get answers - or trigger actions - immediately.
- **One inbox, every channel.** No more switching between 6 different apps. Every message from every platform flows into one screen.
- **Full context, always.** Customer history, sentiment, intent, and past interactions follow every conversation - across channels and over time.
- **No code, no consultants.** Everything is configurable through a visual interface or natural language. Most teams go live in under 15 minutes.
- **The system gets smarter over time.** Every interaction feeds back into the platform - improving suggestions, optimizing timing, and surfacing insights automatically.

---

## 3. Supported Communication Channels

GOTCHA supports the following messaging channels, all unified into a single inbox:

| Channel | Description |
|---------|-------------|
| **WhatsApp** | WhatsApp Business via Meta Cloud API. Supports text, images, documents, quick reply buttons, and list messages. Integrated via Embedded Signup for easy onboarding. |
| **Facebook Messenger** | Full Messenger integration for Facebook Pages. Supports text, media, and structured messages. |
| **Instagram DMs** | Direct Messages from Instagram business accounts. Conversations triggered by DMs, story replies, or comments. |
| **Gmail** | Full email integration via Gmail OAuth. Incoming emails become conversations; agent replies are sent as email threads. |
| **Microsoft Outlook** | Email integration via Microsoft Graph API / OAuth. Same unified experience as Gmail. |
| **Slack** | Slack workspace integration via OAuth. Messages from Slack channels or DMs flow into GOTCHA as conversations. |
| **Web Chat** | An embeddable chat widget for any website. Customers can start conversations directly from the business's site. Fully customizable appearance. |

All channels support:
- Real-time message delivery and receipt
- Media attachments (images, files, documents)
- Conversation history and continuity
- AI co-pilot assistance
- Assignment and routing rules
- AI-triggered actions and workflow execution

---

## 4. Key Features

### 4.1 Unified Omnichannel Inbox

The heart of GOTCHA. Every message from every connected channel appears in a single conversation list. Agents see:

- **All active conversations** across all channels in one view
- **Channel indicators** showing where each conversation originated (WhatsApp icon, Instagram icon, etc.)
- **Smart routing** that sends each conversation to the right agent based on skill, workload, priority, and department
- **Full cross-channel history** - if a customer messaged on WhatsApp last week and emails today, the agent sees both
- **Conversation status** - Open, Pending, Resolved, or Closed
- **Assignment controls** - claim from queue, transfer between agents or departments
- **Real-time updates** via WebSocket - new messages appear instantly without refreshing

### 4.2 AI Co-Pilot

The AI Co-Pilot is an intelligent assistant that sits beside every agent during every conversation. It does not respond to customers directly - instead, it helps the human agent respond better and faster.

**What the Co-Pilot does:**

- **Suggests replies:** Reads the full conversation context, pulls relevant information from the knowledge base, and drafts a suggested reply the agent can send with one click.
- **Summarizes conversations:** Generates automatic summaries of ongoing and completed conversations - what happened, what was resolved, and what's pending.
- **Detects intent:** Classifies the customer's intent in real-time (e.g., "return request," "pricing inquiry," "complaint").
- **Detects sentiment:** Identifies whether the customer is satisfied, frustrated, neutral, or angry - and alerts the agent when tone shifts.
- **Provides context cards:** Shows relevant customer information - purchase history, previous interactions, tags, and notes - in a sidebar panel.
- **Learns from the knowledge base:** Uses uploaded documents, FAQs, and product information to ground its suggestions in accurate, company-specific information.

**How it works technically:**

The Co-Pilot uses OpenAI large language models combined with Retrieval-Augmented Generation (RAG). When a message arrives, the system:

1. Embeds the message using an embedding model
2. Searches the vector database (Qdrant) for relevant knowledge chunks
3. Assembles a prompt with conversation history + retrieved knowledge + agent configuration
4. Generates a contextual, accurate suggested reply

### 4.3 AI Command Agent

The AI Command Agent is a natural language interface that lets admins and agents interact with the entire platform through conversation - no menus, no dashboards, no manual configuration.

Instead of clicking through pages to find data, build segments, or create automations, users simply describe what they need. The AI Command Agent understands the request, determines the right action, and executes it - or presents results - immediately.

**Three core capabilities:**

**1. Ask - Business Intelligence via Conversation**

Query any business metric using natural language. The AI translates the question into the appropriate data lookup and returns a clear, formatted answer.

Examples:
- *"How many leads closed this week?"* → Returns the count with a breakdown by channel and agent.
- *"What's our average response time today?"* → Returns the metric with comparison to yesterday.
- *"Which department has the highest resolution rate?"* → Returns a ranked summary with percentages.
- *"Show me all unresolved conversations from VIP customers"* → Returns a filtered conversation list.

**2. Act - Execute Operations Instantly**

Trigger actions directly from a natural language command. The system validates the action, shows a preview, and executes upon confirmation.

Examples:
- *"Send a message to all customers who haven't purchased in 30 days"* → Builds the audience, drafts the message, shows preview, sends on approval.
- *"Tag all conversations from last week about refunds as 'refund-request'"* → Applies tags in bulk.
- *"Assign all open Instagram conversations to Sarah"* → Reassigns conversations immediately.
- *"Update the CRM status for lead #4521 to 'qualified'"* → Executes the HubSpot update.

**3. Automate - Build Workflows with Words**

Create conversation flows and automations by describing the desired behavior. The system generates the flow structure, presents it for review, and deploys on approval.

Examples:
- *"Build a follow-up flow for new leads: send welcome message, wait 24 hours, send a discount offer, wait 48 hours, assign to sales agent"* → Generates a complete flow with the correct nodes and timing.
- *"Create a rule that routes all Hebrew messages to the Hebrew support team"* → Adds a new AI Router rule.
- *"Set up an automation that tags customers as VIP after their third purchase"* → Creates an event-driven workflow.

**Why this matters:**

The AI Command Agent replaces the need for separate dashboards, manual segmentation tools, and rule-based automation builders. A single conversational interface gives every user - regardless of technical skill - the power to understand, act on, and automate their business operations.

### 4.4 AI Studio

AI Studio is the unified workspace where businesses configure all AI behavior from one place. It replaces fragmented settings scattered across multiple pages with a single, intuitive dashboard.

**AI Studio has five main sections:**

#### 4.4.1 AI Agents

Agents are AI personas that represent specific roles in the business. Each agent has:

- **Name and role** (e.g., "Maya - Support Agent," "David - Sales Agent")
- **Personality settings** - tone (professional, friendly, casual, formal), language, style preferences
- **Assigned tools** - what the agent can do (look up orders, check shipments, process refunds)
- **Linked knowledge sources** - which documents and FAQs the agent can reference
- **Escalation rules** - when to hand off to a human (customer asks for a human, anger detected, after N failed attempts, high-value transaction)
- **Channel assignments** - which channels this agent is active on

Agents are configured through a **form-based interface** (not raw prompts), making it accessible to non-technical users. Every agent has a **test simulator** for previewing behavior before deployment.

#### 4.4.2 Conversation Flow Builder

A visual drag-and-drop flow builder for creating structured conversation paths. Flows combine fixed logic with AI intelligence - perfect for scenarios that need structure but also flexibility.

**Use cases:** Welcome sequences, lead qualification, order status checks, appointment booking, feedback collection, FAQ routing.

**Available node types:**

| Node | What It Does |
|------|-------------|
| Send Message | Send text, image, or file to the customer |
| Quick Reply | Present clickable option buttons |
| Condition | Branch based on time, customer attribute, keyword, or variable |
| AI Agent | Hand off to an AI agent for dynamic conversation |
| Tool Call | Execute an action (check order status, book appointment) |
| Wait | Pause for customer response or a time delay |
| Human Escalation | Transfer to a human agent |
| Set Variable | Store data for use later in the flow |
| HTTP Request | Call an external API |
| Note | Internal annotation (not visible to customer) |

Flows support **variables** (e.g., `{{customer.firstName}}`, `{{order.status}}`), **conditional branching** with AND/OR logic, and **templates** to start from pre-built patterns.

**Prompt-Based Flow Creation:**

In addition to the visual drag-and-drop builder, flows can be created entirely through natural language. Users describe the desired flow in plain words, and the system automatically generates the complete flow structure.

Example prompt:
> "Send a welcome message, wait 1 hour, ask if the customer needs help, if they say yes route to support agent, if no send a satisfaction survey and close the conversation."

The system:
1. **Parses the intent** - identifies each step, condition, and branch
2. **Generates the flow structure** - creates the correct nodes, connections, and logic
3. **Renders a visual preview** - shows the flow on the canvas for review
4. **Allows refinement via follow-up prompts** - "Add a 30-minute timeout after the question" or "Change the wait to 2 hours"

This means non-technical users can build sophisticated automations by simply describing what they want. The visual builder and prompt-based creation work together - create with words, fine-tune visually, or vice versa.

#### 4.4.3 AI Router

The AI Router is the intelligent traffic controller that decides what happens when a new message arrives. It evaluates every incoming message and routes it to the right handler.

**How it works:**

Rules are evaluated **top to bottom** in priority order. The first matching rule wins.

Example routing table:

| Priority | Rule | Route To |
|----------|------|----------|
| 1 | VIP customers | Human Agent (direct) |
| 2 | Intent: "cancel order" | Returns Flow |
| 3 | Intent: "track order" | Support Agent |
| 4 | Intent: "pricing/buy" | Sales Agent |
| 5 | After business hours | After-Hours Flow |
| 6 | Everything else | General Agent |

**Rule conditions can be based on:**
- Customer tags or attributes (VIP, new customer, etc.)
- Detected intent (using AI classification)
- Keywords or phrases in the message
- Time of day / business hours
- Channel (WhatsApp vs. email vs. Instagram)
- Customer language
- Any combination of the above (AND/OR logic)

**Route targets:**
- A specific AI Agent
- A conversation Flow
- A human agent or department
- A queue (round-robin or claim-based)

#### 4.4.4 Knowledge Sources

The Knowledge Base is the company's brain - a centralized repository of information that powers the AI Co-Pilot, AI Agents, and conversation flows.

**Supported source types:**

| Source | Description |
|--------|-------------|
| **File Upload** | Upload PDF, DOCX, Markdown, or TXT files. Documents are automatically parsed, chunked, and embedded for semantic search. Max 10 MB per file. |
| **Text / FAQ** | Paste text directly - product descriptions, policies, frequently asked questions. |
| **URL** | Provide a web URL. GOTCHA fetches and indexes the content. |
| **Confluence** | OAuth integration with Atlassian Confluence. Browse spaces and pages, select content to sync. |
| **Google Drive** | OAuth integration with Google Drive. Browse and sync documents directly from Drive. |

**How knowledge retrieval works:**

1. Documents are split into small chunks (configurable, default ~500 tokens with 50-token overlap)
2. Each chunk is converted to a vector embedding using OpenAI's embedding model
3. Embeddings are stored in a Qdrant vector database
4. When a customer asks a question, the system embeds the query and finds the most semantically similar chunks
5. Retrieved chunks are injected into the AI prompt as context
6. The AI generates an answer grounded in the company's actual knowledge

**Knowledge scoping:**
- Knowledge bases can be scoped to **all agents**, a **specific agent**, or a **specific department**
- Multiple knowledge bases can be active simultaneously
- Each knowledge base can be toggled on/off independently

#### 4.4.5 AI Actions Engine (Tools & Integrations)

The AI Actions Engine is the execution layer that connects GOTCHA to external systems - and gives the AI the ability to not just respond, but **act**.

When an AI Agent or Flow encounters a situation that requires action - looking up an order, updating a CRM record, or triggering an external workflow - the Actions Engine handles it. This transforms GOTCHA from a messaging platform into a system that gets things done.

**What the AI can execute:**

| Action Category | Examples |
|----------------|---------|
| **Messaging** | Send 1:1 messages, broadcast to segments, schedule follow-ups |
| **CRM Operations** | Create/update contacts, log activities, move deals through pipeline stages |
| **Task Management** | Create tasks, assign to team members, set due dates |
| **Workflow Triggers** | Start a conversation flow, activate an automation, fire a webhook |
| **Data Queries** | Look up orders, check inventory, retrieve customer history |
| **External APIs** | Call any third-party system via HTTP request |

**Available integrations:**

| Integration | Capabilities |
|------------|-------------|
| **Shopify** | Look up orders, track shipments, check inventory, process refunds |
| **HubSpot** | Look up contacts, create/update deals, log activities, move pipeline stages |
| **Custom Webhooks** | Call any external API via HTTP requests |

**Execution safeguards:**

Every action executed by the AI goes through a structured pipeline:

- **Validation:** The system verifies that the action is well-formed and the required data is available before execution.
- **Approval gates:** High-risk or high-impact actions (e.g., processing a refund, sending a broadcast to 500+ contacts) can be configured to require human approval before execution. The system shows a preview of what will happen and waits for confirmation.
- **Logging and auditability:** Every action is logged with a timestamp, the triggering event, the executing agent, and the outcome. This creates a full audit trail for compliance and debugging.
- **Measurability:** Action outcomes are tracked - delivery rates for messages, success rates for API calls, conversion rates for automated follow-ups - feeding into the analytics and optimization loop.

Tools can be assigned to specific agents, and high-risk actions (like processing refunds) display warning labels so businesses can control which agents have access to sensitive operations.

---

## 5. Team Management

### 5.1 Roles & Permissions

GOTCHA uses a three-tier role system:

| Role | Description |
|------|-------------|
| **System Admin** | Super-user who manages all tenants. Has access to the system-wide admin panel for tenant lifecycle management. |
| **Admin** | Tenant-level administrator. Can configure channels, AI settings, departments, agents, knowledge bases, and all platform settings. |
| **Agent** | Frontline team member. Handles conversations, uses the AI Co-Pilot, and manages their assigned queues. |

### 5.2 Departments

Conversations are organized by **departments** (e.g., Sales, Support, Billing). Each department can have:

- Its own agents and assignment rules
- Dedicated AI agent configurations
- Specific knowledge bases
- Custom business hours
- SLA targets
- Round-robin or claim-based queue assignment

### 5.3 Conversation Assignment

GOTCHA supports multiple assignment strategies:

- **Round-robin:** Automatically distributes conversations evenly across available agents
- **Claim-based queue:** Conversations enter a shared queue; agents claim them manually
- **Direct assignment:** Route to a specific agent based on rules
- **Department transfer:** Move conversations between departments with full context preserved

---

## 6. Automation Features

### 6.1 Business Hours

Define operating hours per department. Outside business hours:
- Custom auto-reply messages
- Route to after-hours AI agents or flows
- Queue conversations for the next business day

### 6.2 Auto-Greetings

Automatically send a welcome message when a new conversation starts. Configurable per channel and per department.

### 6.3 Idle Reminders

If an agent hasn't responded within a configurable time, the system sends a reminder. Helps maintain SLA compliance.

### 6.4 Auto-Close

Conversations that have been inactive for a configurable period are automatically closed, keeping the inbox clean.

### 6.5 Smart Bot (First Contact)

The bot handles initial customer contact - greeting, qualifying intent, and routing to the right agent or flow. When the conversation needs a human touch, it performs a seamless handover.

### 6.6 Event-Driven Automation

GOTCHA's automation engine is built on an event-driven architecture. Instead of relying on schedules or manual triggers, the system listens for real-time events and responds instantly.

**Core system events:**

| Event | Description | Example Trigger |
|-------|-------------|-----------------|
| **New Message Received** | A customer sends a message on any channel | Route to AI agent, start a flow, notify team |
| **Conversation Created** | A new conversation is opened | Send auto-greeting, assign to queue, log in CRM |
| **Conversation Resolved** | An agent or AI resolves a conversation | Send satisfaction survey, update CRM status, generate summary |
| **Conversation Transferred** | Conversation moves between departments or agents | Notify receiving agent, update context card |
| **Lead Created** | A new lead is identified from a conversation | Start lead nurture flow, create HubSpot contact, notify sales |
| **Tag Applied** | A tag is added to a customer or conversation | Trigger segment-based automation, update audience membership |
| **SLA Breach** | Response or resolution time exceeds the target | Escalate to supervisor, send alert, reassign |
| **Payment Completed** | External payment event received via webhook | Send confirmation message, update order status, trigger follow-up |
| **Business Hours Changed** | Operating hours start or end | Switch between live agents and after-hours AI, update auto-reply |

**What events can trigger:**
- **Flows** - start a specific conversation flow (e.g., post-purchase follow-up when payment completes)
- **Actions** - execute a single operation (e.g., send a message, update a CRM field)
- **Routing decisions** - change how conversations are assigned (e.g., reroute when SLA is breached)
- **Notifications** - alert team members or external systems

Events can be combined with conditions to create precise automations: "When a conversation is resolved AND the customer tag is 'enterprise' AND the sentiment was negative → create a follow-up task for the account manager."

---

## 7. Analytics & Intelligence

### 7.1 Conversation Analytics

- Total conversations by channel, department, and time period
- Resolution rates and first-contact resolution metrics
- Average response times and handling times
- Agent performance metrics

### 7.2 AI Performance

- Co-pilot suggestion acceptance rate
- AI agent resolution rate (target: >60%)
- Knowledge base answer accuracy (target: >85%)
- Routing accuracy (target: >90%)

### 7.3 Customer Intelligence

Every interaction teaches the system more about each customer:
- **Sentiment tracking** - monitors emotional tone across conversations
- **Intent patterns** - identifies recurring topics and needs
- **Conversation summaries** - auto-generated after each interaction
- **Tags and labels** - automatically applied based on conversation content

### 7.4 Conversational Analytics

Beyond traditional dashboards, GOTCHA lets users query business data using natural language - directly from the AI Command Agent or any interface within the platform.

Instead of navigating to a reports page, filtering by date, and exporting a CSV, users simply ask:

| Question | What GOTCHA Returns |
|----------|-------------------|
| *"How many conversations were resolved today?"* | Total count, broken down by channel and department, compared to yesterday |
| *"Which agent has the highest satisfaction score this week?"* | Ranked agent list with scores, conversation counts, and trends |
| *"What are the top 5 reasons customers contact us?"* | Intent analysis with frequency, channel distribution, and trend direction |
| *"Show me the average first-response time for WhatsApp vs. Email"* | Side-by-side comparison with SLA compliance percentage |
| *"How many leads did Instagram generate this month?"* | Lead count with conversion rate and comparison to previous month |

**How it works:**
- The AI interprets the natural language question and maps it to the appropriate data query
- Results are returned in a clear, formatted response - with numbers, comparisons, and context
- Follow-up questions refine the results: *"Break that down by department"* or *"Show me the last 30 days instead"*
- No training required - if a user can describe what they want to know, the system can answer it

### 7.5 Dynamic Audience Segmentation

GOTCHA builds customer audiences dynamically based on real-time data - not static lists. Segments update automatically as customer behavior and attributes change.

**Audiences can be built from:**

| Criteria | Examples |
|----------|---------|
| **CRM Data** | Customer tier, deal stage, lifetime value, account age |
| **Behavior** | Last message date, purchase frequency, channel preference, response rate |
| **Tags** | Any tag applied manually or automatically (e.g., "VIP," "at-risk," "new-lead") |
| **Conversation History** | Number of conversations, resolution outcomes, topics discussed, sentiment trends |
| **Channel** | Customers who interact via WhatsApp vs. email vs. Instagram |
| **Language** | Preferred communication language |

**Used for:**
- **Broadcasts** - send targeted messages to specific segments (e.g., "All VIP customers who haven't purchased in 30 days")
- **Campaigns** - multi-step messaging sequences targeting a defined audience
- **Automations** - trigger flows or actions when a customer enters or exits a segment
- **Reporting** - filter analytics by audience for deeper insights

**Segment examples:**
- "Customers who contacted support more than 3 times this month" → Proactive outreach candidates
- "Leads from Instagram who haven't responded in 7 days" → Re-engagement campaign
- "High-value customers with negative sentiment in their last conversation" → Priority follow-up

Segments are always live - they reflect the current state of the data, not a snapshot from when the segment was created.

---

## 8. Action Approval System

When AI executes actions that have significant impact - broadcasting to hundreds of customers, processing refunds, or modifying CRM data in bulk - GOTCHA enforces a structured approval flow to prevent unintended consequences.

**How it works:**

1. **The AI prepares the action** - whether triggered by a user command, a flow, or an automated rule.
2. **Preview is generated** - the system shows exactly what will happen:
   - For messages: the message content, the target audience, and the audience size
   - For CRM updates: the fields being changed, the affected records, and current vs. new values
   - For bulk operations: the total scope and a sample of affected items
3. **The user reviews** - the preview screen includes:
   - A clear summary of the action
   - The number of affected customers or records
   - An "Edit" option to modify before executing
   - An "Approve" button to proceed
   - A "Cancel" button to abort
4. **Execution and logging** - once approved, the action executes and is logged with the approver's identity, timestamp, and full action details.

**Configurable approval thresholds:**

Businesses can define when approval is required:
- Broadcast messages to more than X recipients
- Refund amounts exceeding a threshold
- CRM modifications affecting more than X records
- Any action flagged as "high-risk" in the tool configuration

Low-risk, routine actions (single message sends, individual CRM lookups) execute immediately without requiring approval - keeping the experience fast while protecting against costly mistakes.

---

## 9. Continuous Optimization Loop

GOTCHA doesn't just execute - it learns. The platform continuously monitors the performance of messages, flows, and AI interactions, and surfaces actionable insights to help businesses improve over time.

**What the system tracks:**

| Metric | What It Measures |
|--------|-----------------|
| **Message effectiveness** | Open rates, response rates, and conversion rates for individual messages and templates |
| **Flow performance** | Completion rates, drop-off points, and average time-to-completion for each flow |
| **Agent suggestion accuracy** | How often Co-Pilot suggestions are accepted, modified, or rejected |
| **Routing precision** | Whether conversations routed by the AI Router reached the right handler on the first try |
| **Resolution quality** | Customer satisfaction scores, re-open rates, and escalation frequency |

**How optimization works:**

1. **Performance tracking** - every message, flow step, and AI interaction is measured against outcome metrics.
2. **Pattern detection** - the system identifies what works and what doesn't. It spots drop-offs in flows, underperforming message templates, and timing patterns.
3. **Insight surfacing** - actionable recommendations are presented to admins:
   - *"Messages sent within 10 minutes of first contact have an 18% higher response rate than those sent after 1 hour."*
   - *"Step 3 of your lead qualification flow has a 40% drop-off rate. Consider simplifying the question."*
   - *"The Support Agent resolves billing questions 25% faster than the General Agent. Consider routing billing inquiries directly."*
4. **Suggested actions** - the system doesn't just report problems, it proposes solutions:
   - "Adjust the wait time in your follow-up flow from 48 hours to 24 hours"
   - "Add a quick-reply option at the drop-off point"
   - "Create a dedicated billing agent with specialized knowledge"

The optimization loop runs continuously - every resolved conversation makes the next one better.

---

## 10. Getting Started

### Step 1: Connect Your Channels
Link WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack, or Web Chat. One setup flow per channel, done in minutes. No code required.

### Step 2: Feed the AI Your Knowledge
Upload documents, FAQs, and brand guidelines. The Co-Pilot learns your company's voice so responses sound like you, not a generic chatbot.

### Step 3: Set the Rules
Define routing rules, assign departments, configure AI agents, and set SLA targets. The right message hits the right person, every time.

### Step 4: Go Live
Customers message you from anywhere. Your team replies from one place with AI-powered suggestions and full context. Most teams are live in under 15 minutes.

---

## 11. Security & Privacy

- **Encryption:** All data is encrypted in transit (TLS) and at rest
- **Authentication:** Single sign-on via Authentik (OIDC Authorization Code + PKCE); services verify RS256 tokens through JWKS, and no passwords or credentials are stored in GOTCHA
- **Multi-tenancy:** Complete data isolation between tenants - each business's data is fully separated
- **Channel credentials:** Stored encrypted using a dedicated encryption key
- **Role-based access:** Granular permissions ensure agents only see what they need
- **Action audit trail:** Every AI-executed action is logged with actor, timestamp, trigger, and outcome
- **Approval controls:** High-impact actions require human confirmation before execution
- **Data policy:** GOTCHA does not sell or share customer data. Ever.

---

## 12. Technical Architecture (Overview)

GOTCHA is built as a modern **microservices** platform with an **event-driven architecture** at its core:

| Component | Technology |
|-----------|-----------|
| **Backend** | Node.js + TypeScript, Express.js |
| **Frontend** | Next.js 14 (React 18), Tailwind CSS |
| **Database** | PostgreSQL (via Prisma ORM) |
| **Cache & Queues** | Redis + BullMQ |
| **Real-Time** | Socket.IO (WebSocket) |
| **AI / Embeddings** | OpenAI API |
| **Vector Search** | Qdrant |
| **Deployment** | Docker Compose, Nginx reverse proxy |

**Core services:**
- **Auth Service** - user authentication, JWT management, onboarding
- **Conversation Service** - conversation lifecycle, message storage, department management
- **Webhook Service** - receives incoming messages from channels (WhatsApp, Messenger, Instagram)
- **AI Service** - knowledge management, embedding generation, AI agent config, routing logic, prompt assembly, command interpretation, and action execution
- **Chatbot Service** - bot flow execution and message routing
- **Analytics Service** - event tracking, usage metrics, and conversational query engine
- **Incoming Worker** - processes inbound messages, triggers AI and routing, emits system events
- **Outgoing Worker** - delivers outbound messages to the correct channel

**Event-driven backbone:**

The platform is built on an event-driven architecture where every significant action - a new message, a conversation transfer, a lead creation, a payment confirmation - emits a system event. These events flow through a centralized event bus (Redis pub/sub + BullMQ) and can trigger any combination of flows, actions, routing decisions, and notifications. This architecture ensures that the system is reactive, scalable, and extensible - new automations can be added by simply listening for existing events.

---

## 13. Supported Languages

GOTCHA's interface supports:
- **English**
- **Hebrew**

AI agents can be configured to respond in any language supported by the underlying AI model, and can be set to match the customer's language automatically.

---

## 14. Frequently Asked Questions

**Q: What exactly is GOTCHA?**
A: GOTCHA is the operating system for customer communication. It's a single inbox for all your messaging channels - WhatsApp, Messenger, Instagram, Gmail, Outlook, Slack - with AI that doesn't just help you reply, but takes action: routing conversations, executing workflows, querying business data, and optimizing performance. It's a conversational interface to your entire business operation.

**Q: Which channels does it support?**
A: WhatsApp, Facebook Messenger, Instagram DMs, Gmail, Outlook, Slack, and Web Chat. Every channel your customers use - in one place.

**Q: What does the AI co-pilot actually do?**
A: It reads incoming messages, pulls relevant info from your knowledge base, and suggests replies your agents can send with one click. It also detects sentiment, classifies intent, summarizes conversations, and provides real-time context about the customer. Think autocomplete, but for customer support - with full business intelligence.

**Q: Can the AI take actions, not just suggest replies?**
A: Yes. GOTCHA's AI can send messages, update CRM records, trigger workflows, create tasks, and call external APIs. High-impact actions require human approval. Routine actions execute automatically. Everything is logged and auditable.

**Q: Can I build automations without coding?**
A: Yes, in two ways. The visual Flow Builder lets you drag and drop nodes to create conversation paths. Or you can describe the flow in plain language - "send welcome message, wait 24 hours, send follow-up, assign to agent" - and the system builds it for you.

**Q: Can I ask questions about my business data?**
A: Yes. Instead of navigating dashboards, you can ask questions like "How many conversations were resolved today?" or "Which agent performs best this week?" and get instant, formatted answers.

**Q: How fast can we get started?**
A: Most teams go live in under 15 minutes. Connect channels, upload your knowledge base, invite your team - done.

**Q: Is our data safe?**
A: Encrypted in transit and at rest. Every AI action is logged and auditable. We don't sell or share your data. Ever.

**Q: Can GOTCHA handle multiple departments?**
A: Yes. You can create unlimited departments (Sales, Support, Billing, etc.), each with its own agents, AI configuration, knowledge bases, business hours, and SLA rules.

**Q: Does it work with our existing tools?**
A: GOTCHA integrates with Shopify (order management), HubSpot (CRM), Confluence (knowledge sync), Google Drive (document sync), and supports custom webhooks for any other system. The AI Actions Engine can call any external API.

**Q: Can I use it in Hebrew?**
A: Yes. The full interface supports English and Hebrew with RTL layout. AI agents can respond in any language.

**Q: What happens after business hours?**
A: You configure after-hours behavior - automatic replies, routing to an AI agent, queueing for the next business day, or triggering a specific conversation flow.

**Q: How does the AI learn about my business?**
A: You upload your documents, FAQs, and product information to the Knowledge Base. The AI uses semantic search to find relevant information and ground its responses in your actual company knowledge - not generic answers. Over time, the system also learns from conversation outcomes to improve its suggestions.

**Q: Can I control what the AI says and does?**
A: Yes. AI Agents are configured through structured forms - you set the tone, personality, allowed actions, escalation rules, and knowledge sources. You can set guardrails and restrictions on what the AI should never say or do. High-impact actions require approval before execution.

**Q: Is GOTCHA a chatbot?**
A: No. GOTCHA is a conversational business operating system. While it includes bot capabilities (conversation flows, automated routing, AI agents), its core purpose is broader - it's the execution layer between your business and your customers. The AI co-pilot augments human agents, the command agent lets you operate your business through conversation, and the automation engine turns events into outcomes.

**Q: How does GOTCHA get smarter over time?**
A: The continuous optimization loop tracks the performance of every message, flow, and interaction. It identifies patterns - what works, what drops off, what converts - and surfaces actionable insights. You get recommendations like "Messages sent within 10 minutes perform 18% better" and suggested fixes for underperforming flows.

---

## 15. Solutions by Team

### Customer Operations
Manage all customer conversations from one unified inbox. Route messages to the right agents, automate repetitive tasks, and keep SLAs on track - all with AI that gets smarter with every interaction. Use the AI Command Agent to query operational metrics and trigger actions without leaving the conversation view.

### Sales
Engage leads the moment they reach out - on any channel. AI qualifies prospects, suggests follow-ups, and gives your sales team the context they need to close faster. Dynamic audience segmentation identifies re-engagement opportunities. Natural language commands let sales managers ask "How many leads closed this week?" and get instant answers.

### Support
Resolve issues faster with AI that understands your product. Copilot drafts replies from your knowledge base, bots handle FAQs, and agents focus on what matters most. The optimization loop identifies recurring issues and suggests knowledge base updates. Event-driven automation triggers post-resolution surveys and follow-ups automatically.

### Social Engagement
Instagram DMs, Facebook comments, WhatsApp - every social touchpoint becomes a managed conversation with real-time sentiment analysis and AI-powered responses. Broadcast to segments built from social engagement data. Track which social channels generate the most leads with conversational analytics.

---

## 16. Glossary

| Term | Definition |
|------|-----------|
| **AI Co-Pilot** | The AI assistant that suggests replies and provides context to human agents during conversations |
| **AI Agent** | A configured AI persona with specific personality, tools, knowledge, and escalation rules |
| **AI Command Agent** | A natural language interface for querying data, executing actions, and building automations through conversation |
| **AI Actions Engine** | The execution layer that enables AI to perform operations - send messages, update CRMs, trigger workflows, and call external APIs |
| **AI Router** | The intelligent system that evaluates incoming messages and routes them to the right handler |
| **AI Studio** | The unified configuration workspace for all AI behavior |
| **Action Approval** | A safety mechanism requiring human confirmation before high-impact AI actions execute |
| **Continuous Optimization Loop** | The system that tracks performance, detects patterns, and surfaces improvement recommendations |
| **Conversation Flow** | A visual, structured conversation path built with drag-and-drop nodes or natural language |
| **Conversational Analytics** | The ability to query business metrics through natural language instead of traditional dashboards |
| **Dynamic Audience Segment** | A live customer group that updates automatically based on real-time CRM data, behavior, tags, and conversation history |
| **Event-Driven Architecture** | A system design where actions are triggered by real-time events (new message, lead created, payment completed) rather than schedules or manual input |
| **Knowledge Base (KB)** | A collection of documents, FAQs, and information that the AI uses to ground its responses |
| **RAG** | Retrieval-Augmented Generation - the technique of retrieving relevant knowledge before generating AI responses |
| **Embedding** | A numerical vector representation of text, used for semantic similarity search |
| **Tenant** | A single business/organization using the GOTCHA platform (multi-tenant architecture) |
| **Department** | An organizational unit within a tenant (e.g., Sales, Support, Billing) |
| **Escalation** | The process of transferring a conversation from an AI agent to a human agent |
| **SLA** | Service Level Agreement - target response and resolution times |
| **Round-Robin** | An assignment strategy that distributes conversations evenly across available agents |
| **Claim Queue** | A shared queue where agents manually pick up conversations |
| **Omnichannel** | The ability to manage conversations across multiple messaging platforms from a single interface |
| **Webhook** | An HTTP callback that delivers real-time notifications when events occur (e.g., new message from WhatsApp) |
| **Interactive Messages** | Rich message formats like quick reply buttons, list messages, and carousels |
