# The GOTCHA Product & Platform Bible

> **Status:** canonical source of truth for everyone building GOTCHA. Supersedes and *merges* the engineering audit (`docs/architecture/ai-employee-platform-audit.md`) and the experience vision (`docs/product/ai-employee-experience-vision.md`) — read those for depth; read this for the definitive line.
> **Author's stance:** written as Founder / CPO / Chief AI Architect. Optimized for the next decade, not this sprint.
> **Frozen by assumption (do not redesign):** cognitive kernel · connector architecture · capability runtime · observation model · operation model.
> **Everything else is in scope** — and everything else is where the category is won.

---

## 0. Evidence base & method

This document was navigated from a knowledge graph of the repo (7,683 nodes · 17,234 edges · 348 communities), not a sequential read. **Every current-state claim is cited** so it can be checked and so this Bible ages honestly:

- `[schema: X]` — verified in `packages/shared/prisma/schema.prisma`, model/enum `X`.
- `[graph: cN Name]` — community N in the graph; `[graph: node]` — a specific extracted node.
- `[file:line]` — direct code verification.

Where the graph and a prior audit disagreed, the graph won and the audit is challenged in-line. Nothing here is speculated; forward-looking design is marked as **vision**, current fact is cited.

**The single most important evidence finding, stated once:**
> The kernel already models *thinking* (Oracle → Reasoner → Guardrails → Runtime → Writer, with replayable runs) `[graph: c16, c21, c15, c5; schema: AgentLoopRun]`. But the **employee** it serves is, in the data model, a **prompt-configuration row with a 3-state switch** `[schema: AIAgent, enum AIAgentStatus = ACTIVE|DRAFT|PAUSED]`. GOTCHA built a mind and gave it no *self* — no career, no authority object, no memory of being coached, no record of its performance, no role it inherits. **The entire product opportunity is to give the employee a self.** That is the thesis of this Bible.

---

## 1. The Vision

### What GOTCHA is
GOTCHA is where a business **hires, trains, trusts, and manages AI Employees** the way it hires, trains, trusts, and manages people — riding a cognitive kernel that reasons before it acts and can explain every decision.

Not a chatbot. Not automation. Not an assistant. An **employee**: a named colleague with a role, a mission, authority it earns, a memory, a manager relationship, and a performance record.

### The problem today
Every business runs on labor it cannot scale linearly: answering customers, qualifying leads, booking meetings, chasing renewals, processing refunds. The two existing options both fail:
- **Hire humans** — expensive, slow to train, 1:1 with volume, gone at 6pm.
- **Buy "AI"** — today's market ships *chatbots and automations wearing an AI badge*: a prompt, a FAQ, a flow chart. They don't reason, can't be supervised into trust, don't improve from correction, and break the moment a real decision is required.

The result: owners who *want* leverage are stuck choosing between a person they can trust but can't scale, and software they can scale but can't trust.

### Why AI Employees, not AI Chatbots
A chatbot **responds**. An employee **decides, acts, and is accountable.** The difference is not model quality — it is the surrounding contract:

| Chatbot | AI Employee |
|---|---|
| Answers a message | Owns an outcome (booked the demo, resolved the ticket) |
| A prompt | A role, a mission, a job description |
| Stateless or shallow memory | Remembers the customer and remembers being corrected |
| Configured | Hired, supervised, promoted |
| "Confidence score" | Authority it earns and can lose |
| A black box | Explains what it did and why, like a colleague |
| Same forever | Gets measurably better because you coached it |

GOTCHA already has the hard part — the reasoning kernel `[graph: c16 Agent Loop & Reasoner]` — that lets an employee genuinely *decide* rather than pattern-match. The category is defined by wrapping that capability in the **employment relationship.**

### The category we are creating
**Employment-as-a-Product.** Not "AI tools for support." Not "an AI agent builder." The primitive we sell is a *colleague you manage.* The competitor is not Intercom or a GPT wrapper — it is **a job requisition.** When an owner thinks "I need to hire someone to do X," GOTCHA is the answer.

### Why this is inevitable
1. **Reasoning got cheap enough to trust with decisions, not just text.** The kernel exists because this is now true.
2. **Labor is the largest line item in every service business**, and the first one owners want leverage on.
3. **Trust is the only barrier left**, and trust is a *product* problem (supervision, explainability, earned authority), not a *model* problem — which means it is winnable by the team that treats it as the product, not the team with the biggest model.
4. **The winner compounds.** Every correction an employee receives is training data and a trust signal at once. The platform that captures the employment relationship captures a data moat no model vendor can replicate.

The only open question is *who* defines the category. This Bible is the bet that it is GOTCHA.

---

## 2. First Principles

Permanent. These should survive every rewrite, model upgrade, and org change. If a decision violates one of these, the decision is wrong.

1. **An AI Employee is a colleague, not a feature.** Every screen is judged by one test: *does this feel like managing a person, or configuring software?* If it feels like configuration, it is a bug.

2. **Trust before autonomy — always earned, never granted by default.** No employee acts with authority it has not demonstrably earned under supervision. The default posture of a new employee is *watched.* (Today this is inverted: autonomy is a global env flag `[flags.ts:33]`, not an earned per-employee state — see §10.)

3. **Reasoning before execution.** The employee decides *why* before it acts *how*. Frozen kernel doctrine `[graph: c16, c21]`. The product must *show* this reasoning, because visible reasoning is what converts a black box into a colleague.

4. **Operations, not prompts.** The employee expresses intent as typed operations validated by the runtime `[graph: c5 Action Contracts Engine]`; it never "just prompts" its way into a side effect. Owners reason about *what an employee can do*, never about prompt text.

5. **Authority is earned, bounded, and revocable.** Authority is a first-class object with limits (money, irreversibility, external reach), raised by track record and instantly lowerable. *(Vision — today authority is scattered across a per-tool boolean and free-text guardrails `[schema: AgentToolPermission.requireApproval, AIAgent.customGuardrails]`.)*

6. **One brain.** Every mode (shadow, assist, autonomous) is the *same* reasoning with *different execution rights* — never a different personality or a forked strategy. (Today partially violated: the live copilot forks strategy `[graph: c9 AI Bot Core, computeBehaviorState()]` — see §10 G-Brain.)

7. **Explainability is a product surface, not a log.** If the owner cannot get, in one glance and in plain language, *what happened / why / what it decided / what it escalated / what it learned* — the feature is unfinished. The corpus already exists `[schema: AgentLoopRun, AgentLoopIteration]`; delivering it is the work.

8. **Learning is the flywheel.** Every correction, override, and 👎 makes the employee measurably better *and* becomes a platform evaluation. Owner trust and product improvement are the **same pipeline**. (Today: no coaching store exists at all — see §10 G-Coach.)

9. **Determinism where it matters.** Safety, authority, escalation ceilings, and money are enforced by deterministic gates, not model judgment `[schema: AIAgent.escalationGates "LLM-independent triggers"]`. The model reasons; the rails hold.

10. **Fail loud, never silent.** An employee that cannot act says so — to the customer and to the owner. Silence is the one unforgivable failure. (P0 closed the known silence paths; the principle is permanent.)

11. **The employee has a self.** It persists across conversations and customers `[schema: AgentCustomerMemory]`, carries its own history and performance, and has a lifecycle (hired → probation → promoted → retired). A stateless "agent" is a chatbot; a *self* is an employee.

12. **Progressive disclosure is law.** Lead with the living employee; hide configuration until asked. Every new capability tempts a new settings toggle; resisting that is a founding discipline, not a preference.

13. **The owner is a manager, not an operator.** The product's job is to make one person supervise many employees by exception — surfacing the important, silencing the mundane, and escalating only what needs a human.

---

## 3. The AI Employee Lifecycle

The spine. Eight phases, each mapped to a human-management primitive. For each: **owner psychology · UX · backend responsibilities · success criteria.** Current-state reality cited; the target is vision.

> **The core defect this section fixes:** today the *entire* lifecycle is three states — `DRAFT`, `ACTIVE`, `PAUSED` `[schema: enum AIAgentStatus]` — plus a global env autonomy flag `[flags.ts:33]`. Hiring, probation, promotion, and retirement do not exist as states. The employee has no arc. Giving it one is the highest-leverage structural change in the product.

### 3.1 NEED — *"I have work no one is doing."*
- **Psychology:** frustration or ambition. "Tickets pile up overnight." "I lose leads I never follow up." The owner is not shopping for AI; they have a *job to be done.*
- **UX:** the entry point is a **job**, phrased as a job: *"I need someone to answer support questions and refund small orders."* Not a "create agent" button.
- **Backend:** capture the intent; infer role, department fit, and likely tools from it and from what's already connected `[schema: Department, AgentToolPermission]`.
- **Success:** the owner sees a plausible *candidate* within seconds, not a form.

### 3.2 HIRING — *"Show me the candidate."*
- **Psychology:** evaluation, not authorship. A manager reacts to a candidate; they do not fill in the candidate's own résumé. Today's wizard inverts this — it interviews the *owner* `[graph: c14 Agent Builder Wizard UI]`.
- **UX (vision):** the platform returns a **candidate** — name, proposed role, a **draft job description**, the **tools it says it needs**, and **questions it has for the owner.** Hiring = approving a person. See §5.
- **Backend:** create the employee record with *inferred* defaults (name, tone, languages, goal, success criteria) `[schema: AIAgent has all of these as defaulted columns]` — the machinery to default is already there; today the wizard asks for them instead.
- **Success:** time-to-hire under 5 minutes; the owner edited a candidate, never completed a settings form.

### 3.3 TRAINING — *"Learn my business."*
- **Psychology:** onboarding a new hire — patience, but an expectation of fast ramp.
- **UX:** connect knowledge sources; the employee reports *what it read and what it still doesn't know.* Today knowledge is a mandatory upload + a one-time **readiness test** `[graph: node readinessreportpanel; schema: AIAgent.readinessReport]` — a good seed, but training *ends* there instead of becoming continuous.
- **Backend:** ingest to per-employee knowledge `[schema: AIAgent.knowledgeBases → AIAgentKnowledge]`; generate readiness coverage/gaps `[graph: readiness = 21 nodes]`.
- **Success:** the employee can state its own coverage and name its gaps before it ever talks to a customer.

### 3.4 PROBATION — *"Prove it while I watch."* **← the trust unlock, and it is missing from the product.**
- **Psychology:** *"I will not hand real customers to something I haven't watched work."* This is the single largest adoption barrier in the entire category.
- **UX (vision):** a first-class, **per-employee, owner-controlled** ladder — **Shadow → Assist → Autonomous** — where the owner watches real decisions on real traffic and *graduates* the employee deliberately. See §6.
- **Backend reality — the machinery exists but is wired wrong for the product:** the three stages exist as `AgentLoopMode = "off" | "shadow" | "autonomous"` `[flags.ts:33]` **but are set by `process.env.AGENT_LOOP_MODE` and gated by an `AGENT_LOOP_TENANTS` allow-list** — i.e. **tenant-wide, env-only, invisible to the owner, not per-employee.** The dry-run/shadow evaluation corpus is real `[graph: c16, node shadow_eval; schema: AgentLoopRun.mode]`. **The gap is not capability — it is that probation is an ops toggle, not a product.**
- **Success:** the owner can say "I watched it handle a week of real conversations before I let it act." Graduation is an earned, reversible event — not a switch.

### 3.5 PROMOTION — *"You've earned more responsibility."*
- **Psychology:** growing confidence; the pleasure of a hire working out.
- **UX (vision):** the employee *asks for a raise* backed by evidence — *"you've approved 47 of my last 50 refund requests; raise my limit to $200?"* — and the owner grants or declines in one tap.
- **Backend:** requires an **Authority object** with track record (does not exist — authority is today a per-tool boolean `[schema: AgentToolPermission.requireApproval]` and free-text `customGuardrails`). See §10 G-Auth.
- **Success:** authority rises with demonstrated reliability; every raise is traceable to evidence.

### 3.6 AUTONOMY — *"Run, and tell me how it went."*
- **Psychology:** delegation. The owner stops watching each action and starts reading summaries.
- **UX:** the employee acts within its envelope, escalates by policy, and **reports back** (the shift report, §8). Today autonomy exists `[schema: AIAgent.maxAutonomousMessages/Minutes/confidenceThreshold; graph: node isoperationautonomous]` but the *report back* does not — after launch the employee goes silent.
- **Backend:** loop runs persist fully `[schema: AgentLoopRun, AgentLoopIteration]`; escalation ceilings are deterministic `[schema: AIAgent.escalationGates]`.
- **Success:** the owner supervises by exception; the employee never acts outside its authority; nothing important happens silently.

### 3.7 SCALING — *"Now I have a team."*
- **Psychology:** shifting from *managing an employee* to *running an organization.*
- **UX:** the abstraction that appears is the **org** — teams, departments, and eventually an **AI Manager** (§7). The org skeleton already exists `[schema: Department with hierarchy, members, aiAgents]` but was built for human support queues and has no AI-manager node.
- **Backend:** department binding is real `[schema: AIAgent.departmentId, Department.aiAgents]`; shared knowledge, shared memory, and delegation between employees are not.
- **Success:** the experience grows with the org instead of collapsing into a flat list of agents.

### 3.8 RETIREMENT — *"You're done; hand off cleanly."*
- **Psychology:** an employee leaving should not orphan its work.
- **UX (vision):** offboarding asks *who inherits its conversations, its customers, and what it learned.* Today deletion exists `[graph: node deleteaiagent]` with no inheritance concept.
- **Backend:** reassign open conversations, transfer per-customer memory `[schema: AgentCustomerMemory]`, archive the performance record.
- **Success:** an employee can leave without a single dropped customer or lost lesson.

---

## 4. The Perfect AI Employee

The ideal model, facet by facet. For each: **what it is · why it exists · today's reality (cited).** This is the target schema of the *self* — not a redesign of the kernel, but the entity the kernel serves.

| Facet | What it is / why it exists | Today `[schema: AIAgent unless noted]` |
|---|---|---|
| **Identity** | Name, role, avatar, persona, voice. *Why:* a colleague is a someone, not a config. | ✅ `name, role(string), avatarColor, persona, identity(JSON), tone, style` |
| **Mission** | One-line reason it exists ("book qualified demos"). *Why:* mission is the emotional core that makes it a hire, and the north star the kernel optimizes. | ⚠️ `goal` + `successCriteria` columns exist but are framed as prompt inputs, not a stated identity the employee can voice |
| **Knowledge** | What it's been taught + **what it knows it doesn't**. *Why:* an employee that can't name its gaps will hallucinate into them. | ⚠️ `knowledgeBases` + one-time `readinessReport`; no continuous "teach me" |
| **Authority** | The envelope: what it may do alone vs must ask, by money / irreversibility / external reach — with a **track record** and the ability to earn raises. *Why:* authority *is* the trust contract. | ❌ Scattered: per-tool `AgentToolPermission.requireApproval` (boolean), `customGuardrails` (free text), `behavioral.forbiddenActions`, `confidenceThreshold`. No envelope, no limits, no track record. `[graph: authority = a prompt hierarchy + a test only]` |
| **Operations** | The typed, contract-validated actions it can perform. *Why:* operations (not prompts) are how an employee affects the world safely. | ✅ Frozen runtime `[graph: c5 Action Contracts Engine; schema: ExecutionMode incl. dry_run]` |
| **Capabilities** | Which integrations/worlds it can see and act in, and which modes it may run in. *Why:* capability = the employee's "access badge." | ✅ `capabilities{auto,assist}`; `AgentToolPermission` with **per-agent tool semantics** (same tool means different things to different roles — a genuine strength) |
| **Memory** | Per-customer continuity + learned corrections. *Why:* remembering the customer is table-stakes; remembering being coached is the moat. | ⚠️ `AgentCustomerMemory` (per customer, bounded, from Reasoner) is real — but it's *runtime* memory, **not** an owner-coaching store |
| **Goals** | The outcomes it drives toward, per role/funnel. *Why:* an employee owns outcomes, not messages. | ✅ `goal`, `successCriteria`; funnel binding `[schema: AIAgent.funnelId]` |
| **KPIs** | Numeric targets (resolution %, demos/week, cost/outcome). *Why:* you can't manage what you don't measure; KPIs turn "goal" into "performance." | ❌ No numeric KPI/target fields anywhere on the employee |
| **Performance** | A rolling record: outcomes, escalation rate, override-rate trend, cost, $ saved. *Why:* the owner manages to performance, and promotion needs evidence. | ❌ Raw `AgentLoopRun` runs exist; **no aggregated performance record on the employee** |
| **History** | Its full replayable activity. *Why:* trust requires an auditable past. | ✅ `AgentLoopRun` + `AgentLoopIteration` (replayable, with facts snapshots) — a real asset |
| **Coaching** | The store of corrections the owner has given, remembered and applied. *Why:* this is the learning flywheel; without it, correction goes nowhere. | ❌ **Does not exist.** No coaching/correction model |
| **Safety** | Deterministic, model-independent hard limits. *Why:* rails must not depend on the thing they constrain. | ✅ `escalationGates` (deterministic), `behavioral.safetyBoundaries`, `customGuardrails` |
| **Relationships** | Its department, its manager, its peers, its customers. *Why:* employees exist in an org, not in isolation. | ⚠️ `departmentId` (to a human-shaped Department); **no manager, no peers** |
| **Growth** | Its lifecycle state and graduation history. *Why:* a self has an arc; a config has a value. | ❌ Only `status: DRAFT/ACTIVE/PAUSED` + global env mode. No probation/promotion state |
| **Future expansion** | Room for skills marketplaces, certifications, cross-tenant reputation. *Why:* the model must not need a migration to grow. | — design the entity for extension now |

**The pattern is unmistakable:** the facets that make it a *tool* are ✅ (identity, operations, capabilities, history). The facets that make it an *employee* are ❌ (authority envelope, KPIs, performance record, coaching, growth). **That column of ❌ is the product.**

---

## 5. Employee Creation — the perfect hiring experience

Forget the wizard `[graph: c14 Agent Builder Wizard UI, builderStep chat→kb→refine→tools]`. It is the right *species* (conversational, drafts, readiness) with the wrong *direction*: it interviews the owner for things the platform can infer.

### The design: hire from a job posting
1. **The owner writes one sentence.** *"I need someone to qualify inbound leads and book demos."*
2. **The platform presents a candidate** — name, role, a **job description it wrote**, the **tools it needs** ("I'll need your calendar and your CRM"), a **starting authority envelope** it proposes, and **the questions it still has** ("What's the smallest deal worth booking a demo for?").
3. **The owner reacts** — edits the candidate, answers a question or two, hires. Approving a person, not submitting a form.

### What the owner actually decides (only this)
- **The job** (one sentence) — the irreducible input.
- **The authority envelope** — what it may do alone. The one decision only the owner can make, because it encodes *their* risk tolerance.
- **Knowledge source** — what it must be right about.

### What the AI infers automatically (everything else)
Name, tone, languages, persona, communication style, goal + success criteria, funnel fit, department fit, the tool list, escalation defaults. **All of these already exist as *defaulted* columns** `[schema: AIAgent — name, tone, languages, style, goal, successCriteria, escalationRules all have defaults]` — the platform already *can* default them; today the wizard *asks* instead. Inverting that is mostly product work, not kernel work.

### What must never be asked
- Per-tool checkboxes (the employee proposes its toolset; the owner edits by exception).
- Model, temperature, max tokens, provider `[schema: AIAgent.model/temperature/maxTokens/provider]` — these are *never* an owner's concern; they are platform defaults.
- Prompt text, in any form. If an owner is editing a prompt, the abstraction has failed.
- Funnel structure, formality sliders, language toggles — inferred from role and business, corrected by exception.

**Success criterion:** an owner who has never seen the product hires a working employee in under five minutes and never once feels they configured software.

---

## 6. The Trust System — the heart of GOTCHA

Trust is the whole game, and it is a *product* problem. An owner reaches "let AI run my business" through a **deliberate, watchable, reversible escalation of authority** — never a leap of faith.

### The ladder (per-employee, owner-controlled)

| Stage | Employee does | Owner does | Authority | Kernel today |
|---|---|---|---|---|
| **Shadow** | Handles real traffic in the background; drafts what it *would* do; sends nothing | Watches its decisions beside what actually happened | None | ✅ exists as `mode="shadow"` `[schema: AgentLoopRun.mode]`, but env-gated `[flags.ts:33]` |
| **Assist** | Acts for real, but **every action waits for approval** | Approves / edits in-flight; sees it get things right | Propose-only | ✅ approval surface real `[graph: ApprovalRequest; c15]`; ⚠️ resume path (see §10 G-Resume) |
| **Autonomous** | Acts within its authority envelope; escalates by policy | Reviews the shift report; spot-checks | Full within envelope | ✅ exists `[schema: maxAutonomous*]`, env-gated |

Graduation is **earned on watched evidence** and **reversible** (a struggling employee is demoted to Assist, exactly like a real one). This is the ritual that converts *"I'd never trust AI with my customers"* into *"I supervised it for a week — it's ready."*

### The components, each in service of trust
- **Authority** — a first-class envelope (money / irreversibility / external reach), raised by track record. *(Vision; today a per-tool boolean + free text — §10 G-Auth.)* Principle 5.
- **Approvals** — the product's best-explained surface today `[graph: c15 Execution & Approvals Runtime]`: what / why / risk / params / policy / decide. The **tonal template for everything else.** Enrich with: if-you-reject-this-here's-my-plan-B, and the employee's track record on this kind of decision.
- **Confidence** — never shown as a naked number. Expressed as *behavior*: high confidence acts; low confidence asks. `confidenceThreshold` exists `[schema: AIAgent]`; surface it as a dial ("how sure before you act alone"), not a float.
- **Reports** — the employee proactively tells the owner how the shift went (§8). Silence is the trust-killer (Principle 10).
- **Feedback & Training** — every 👎/override/edit is captured as coaching the employee remembers, and the override-rate-declining trend is shown with pride. *(Vision; no store today — §10 G-Coach.)*
- **Explainability** — the reasoning corpus rendered at **colleague altitude**, with progressive depth (headline → reasoning → full trace). The corpus is exceptional and already persisted `[schema: AgentLoopIteration with reasoningSummary + facts snapshots]`; the delivery is the work (challenging the prior audit's framing that this is "just one read API" — it is a *product surface*, not a plumbing task).
- **Risk** — the owner sets risk tolerance once (the authority envelope) and the system honors it deterministically `[schema: escalationGates]`; risk is *explained*, never buried in confidence math.
- **Learning** — the flywheel that makes trust compound: more corrections → fewer needed → higher earned authority → owner relaxes. Principle 8.

**Design rule for this section:** every element must *increase* trust or it doesn't ship. If a feature makes the employee more capable but less *supervisable*, it is net-negative until the supervision catches up.

---

## 7. Operating an Organization

How the experience must evolve as the owner scales. Grounded in what the org model already is `[schema: Department, DepartmentMember, AgentToolPermission]`.

| Scale | Right abstraction | Reality today |
|---|---|---|
| **1 employee** | The living Profile (§8) | ⚠️ nine config sections, not a profile |
| **5** | A **team view** (org chart), a routing "front desk" | ⚠️ flat agent list; routing via FlowCanvas/RouterRule `[schema: AIAgent.routerRules]` |
| **20** | **Departments** with shared knowledge + shared policies | ✅ Department is rich: hierarchy `[parentId/children]`, working hours, SLA, escalation policy, queue mode — **but built for human queues**; `members` are humans only `[DepartmentMember → User]`, AI is bolted on via nullable `departmentId` |
| **100** | An **AI Manager** layer: supervises employees, escalates to the human only above the line | ❌ **No AI-manager exists** `[graph: Manager = 1 RBAC-doc node]`; department escalation targets are humans |

### The abstractions that must appear
- **Departments** — already the natural container; the work is making them *AI-native* (a department has a shared knowledge base, shared policies, and a manager) rather than a human support-queue with agents attached. No `Organization` model is needed above `Tenant` `[schema: Tenant is the org root]` — the tree is Tenant → Department → Employee.
- **AI Managers** — the killer scale primitive and a *natural* extension of the frozen kernel: **a manager is an employee whose customers are other employees' escalations.** It reviews, coaches, and escalates upward only what needs a human. Without it, 100 employees is 100 anxieties on one owner.
- **Delegation** — employees hand work to each other (SDR → Account Manager) instead of every path ending at the human. Today every escalation ends at a person `[schema: Department.escalationPolicy.escalateTo]`.
- **Shared knowledge** — owned at the department level, inherited by employees. Today knowledge is per-employee `[schema: AIAgentKnowledge]`.
- **Shared memory** — a department-level view of a customer, so two employees don't re-ask what a third already learned. Today memory is per-(employee,customer) `[schema: AgentCustomerMemory unique on agentId+customer]`.
- **Shared policies** — authority envelopes and guardrails set once per department, inherited and overridable per employee.
- **Career progression** — roles as a ladder (SDR → Sales Rep → Account Manager) an employee can be promoted *along*, carrying its history.

### Monitoring at scale
The owner monitors the *org*, not each employee: a department health board, exceptions surfaced by the AI Manager, and drill-down only where a number is off. Supervision by exception is the only thing that makes 100 employees feel like fewer than 10.

---

## 8. Owner Experience — make it feel like managing people

What the owner sees **every day**. The organizing metaphor is *a manager's Monday morning*, not a telemetry console.

### The daily surface
- **The Shift Report (headline).** Each employee tells the owner, in plain language, how the shift went: *"Handled 34 conversations, booked 3 demos, refunded 2 small orders, escalated 1 angry customer to you, and got stuck twice on your return policy — can you teach me?"* The corpus to generate this exists `[schema: AgentLoopRun with goal + terminationReason + reply]`; the *narrative* does not. **This is the highest-value daily surface and it does not exist today.**
- **The living Employee Profile.** One page per employee — *Overview (who + mission + health) · Today (activity + what it's waiting on) · Knowledge (taught + gaps) · Access (integrations + authority) · Performance (outcomes + trends)* — with a quiet **Manage** drawer for the rare config edit. Replaces the nine settings sections that exist today `[schema: AIAgent's ~30 config columns]`.
- **Notifications = escalations and exceptions only.** The employee interrupts the owner for a decision or a problem, never for noise. Escalation reasons are first-class `[schema: AIAgent.escalationRules + escalationGates]` and now surfaced (P0-7).
- **Performance reviews.** A weekly/monthly per-employee review framed like a real one: outcomes, the **override-rate-declining trend** (the single most trust-building metric), cost per outcome, and $ saved vs a human FTE. Requires the performance record that doesn't exist yet (§10 G-Perf).
- **Problems & Successes.** The dashboard leads with *"3 employees are performing above target; 1 needs your attention because its escalation rate jumped"* — human framing, not charts-first.
- **Coaching inbox.** Where "teach me" cards and correction opportunities collect (§10 G-Coach).
- **Insights.** The AI Manager (at scale) surfaces cross-employee patterns: *"customers keep asking about X and no one has an answer — want to teach the team?"*

### Metrics doctrine (what to feature, what to bury)
- **Vanity (bury):** messages sent, tokens, raw "AI handled %", response time in isolation. *(Note: the graph caught a `analytics_page_demo_department_data` node `[graph]` — the analytics page was fabricated demo data until P0 replaced it; a permanent lesson: never ship a vanity screen with fake numbers.)*
- **Trust (feature):** resolution rate, escalation rate + reasons, **override-rate trend**, customer sentiment, approval rate.
- **Revenue (headline):** meetings booked, leads qualified, deals influenced, **revenue touched, cost per outcome (not per token), $ saved vs a human FTE.**

The headline is always **outcomes and money, framed as a performance review.** Telemetry lives one click down, for the rare debug.

---

## 9. Platform Standards

Permanent, deterministic company standards. These make GOTCHA a *platform*, not a pile of features. Each is stated as a rule that should almost never change.

- **Employees** — every employee is a persistent *self* with the §4 facets; a stateless agent is not a valid employee. All employee behavior flows through the one kernel (Principle 6). No employee bypasses the runtime, guardrails, or tool-gate — *verified true in the current codebase* `[graph: c15, c21; audit §2.7]` and to be held forever.
- **Roles** — roles are **data, not code.** A role is a versioned `RoleDefinition` (identity template, default goals/KPIs, operation needs, default authority envelope, knowledge scaffold) that employees *inherit and customize.* **Today roles are compiled** — `role` is a string with a `custom` value `[schema: AIAgent.role]`, there is **no `RoleDefinition` table** (verified: 0 models), and a new role is 7-8 synchronized code edits across packages + frontend `[audit §10]`. This is the biggest believability gap between the pitch ("hire an SDR / Receptionist / Billing Specialist") and the code. **Standard: no role ships as code again.**
- **Skills** — reusable, composable capability bundles seeded via the proven industry-pack pattern; data-shaped and inheritable. A skills surface exists `[graph: node skillstab, aiskillkind schema]`; the standard is that skills are *composed*, never hand-coded per employee.
- **Operations** — every side effect is a typed, contract-validated operation with PRE/POST invariants `[graph: c5 Action Contracts Engine]`. Frozen. **Standard: no side effect without a contract.**
- **Connectors / Integrations** — one connector model; every integration reaches the employee as capabilities/operations, never as bespoke code. Frozen architecture `[graph: c6 Integrations Marketplace UI]`. **Standard: an integration is "giving the employee keys," presented as access-granting with the employee narrating what it unlocks and where its limits are** (the effective-permissions view — P1-8 — is the trust surface).
- **Knowledge** — versioned, per-employee or per-department, with coverage/gap reporting as a first-class output `[schema: readinessReport]`. **Standard: an employee must be able to state what it knows and what it doesn't.**
- **Memory** — bounded, typed, and owned at the right scope (per-customer today `[schema: AgentCustomerMemory]`; per-department at scale). **Standard: memory is bounded and inspectable, never an unbounded prompt dump.**
- **Evaluations** — every correction becomes a replayable eval; graduation and legacy-deletion are **gated on eval evidence** `[schema: reasoner_shadow_evals; graph: c16 shadow_eval]`. **Standard: no autonomy graduation and no legacy deletion without eval evidence.**
- **Datasets** — the corpora (runs, iterations, shadow evals, corrections) are first-class, versioned assets — the data moat. **Standard: never throw away a correction or a run.**
- **Prompt evolution** — prompts are versioned artifacts `[schema: AgentLoopRun.promptVersion]`, evolved against the eval corpus, never hand-tuned in production. **Standard: prompt changes are evaluated, not vibes.**

---

## 10. Gap Analysis — vision vs. current product

Every gap is evidence-cited. Columns: **Priority · Business impact · Technical impact · Difficulty · Dependencies · ROI.** Difficulty/ROI are relative (kernel is frozen; most gaps are product+data, which is the good news).

> **Table-stakes already closed (P0, 2026-07-05):** reachability, fail-loud, real analytics, enforced pause, correct cost, hand-back-to-AI. These moved the product from *lying* to *honest*. They are **not** differentiation. Everything below is what moves it from *honest tool* to *hired colleague.*

| ID | Gap | Evidence | Priority | Business impact | Technical impact | Difficulty | Dependencies | ROI |
|---|---|---|---|---|---|---|---|---|
| **G-Prob** | Probation is an env flag, not an owner-visible per-employee ladder | `[flags.ts:33]` env `AGENT_LOOP_MODE`; `probation`=1 docs node | **P0** | Highest — the #1 adoption barrier (trust cold-start) | Move mode from env to per-employee state; surface UI | Med | Employee lifecycle state (new); §6 UI | ★★★★★ |
| **G-Profile** | No living profile; employee is 9 config sections | `[schema: AIAgent ~30 columns]` | **P0** | High — the owner's daily home doesn't feel like a person | Read-model + IA; no kernel change | Med | Performance read-model (G-Perf) | ★★★★★ |
| **G-Report** | No proactive shift report; employee goes silent after launch | corpus exists `[schema: AgentLoopRun]`, no narrative | **P0** | High — silence reads as out-of-control | Summarize runs → NL; new surface | Med | — | ★★★★☆ |
| **G-Auth** | Authority is a per-tool boolean + free text, not an earned envelope | `[schema: AgentToolPermission.requireApproval, AIAgent.customGuardrails]`; `authority`=prompt-only `[graph]` | **P0** | High — authority *is* the trust contract; enables promotion | New Authority object (money/irreversibility/reach + track record) | Med-High | Performance record | ★★★★★ |
| **G-Coach** | No coaching store; corrections vanish | no coaching model `[schema]` | **P1** | High — the learning flywheel; also the eval moat | New coaching store; wire override/👎 capture; feed prompt/memory + evals | High | Eval corpus `[schema: reasoner_shadow_evals]` | ★★★★★ |
| **G-Perf** | No performance record/KPIs on the employee | raw `AgentLoopRun` only, no rollup; no KPI fields | **P1** | High — you manage to performance; promotion needs evidence | Aggregation read-model + KPI fields | Med | Turn attribution (done P1-6) | ★★★★☆ |
| **G-Hire** | Wizard interviews the owner instead of presenting a candidate | `[graph: c14, builderStep]` | **P1** | High — the first-5-minutes "employee vs software" feeling | Invert flow; defaults already exist `[schema]` | Med | Role-as-data (G-Roles) strengthens it | ★★★★☆ |
| **G-Brain** | Copilot forks strategy — violates "one brain" | `[graph: c9, computeBehaviorState()]`; audit §8 | **P1** | Med — inconsistency erodes trust; deepens migration debt | Converge copilot onto kernel reasoning | High | Kernel graduation | ★★★☆☆ |
| **G-Explain** | Reasoning corpus under-delivered to owner (colleague-altitude, progressive depth) | `[schema: AgentLoopIteration.reasoningSummary]`; timeline read-API landed P1-5 | **P1** | High — visible reasoning is what makes it a colleague | Product surface over existing read-API | Med | Profile (G-Profile) | ★★★★☆ |
| **G-Roles** | Roles compiled; no `RoleDefinition` table | 0 role models `[schema]`; `role` is a string; audit §10 | **P2** | Med-High — the "role library" pitch is hollow until this | Data registry (kernel-safe); loop binding ~90% there `[audit §10]` | Med-High | — | ★★★☆☆ |
| **G-Org** | Org tree is human-shaped; no AI Manager, no shared AI memory/delegation | `[schema: Department members=humans; Manager=1 doc node]` | **P2** | Med now, High at scale — gates the 100-employee story | AI-native department + manager-as-employee | High | Kernel autonomy proven; G-Auth | ★★★☆☆ |
| **G-Learn** | No felt improvement loop (override-rate trend shown) | derives from G-Coach + G-Perf | **P2** | High — compounding trust signal | Trend surface | Low (once G-Coach+G-Perf) | G-Coach, G-Perf | ★★★★☆ |
| **G-Know** | Knowledge is passive (upload + one test), not "teach me" | `[schema: readinessReport one-time]` | **P2** | Med — reduces hallucination, feels like onboarding | Gap→card loop | Med | G-Coach surface | ★★★☆☆ |
| **G-Retire** | No offboarding/inheritance | `[graph: deleteaiagent]`, no inheritance | **P3** | Low-Med — trust in reversibility | Reassign convos + memory + archive | Low-Med | — | ★★★☆☆ |

**Reading the table:** the ✅ facets are all *tool* facets; every P0/P1 gap is an *employee* facet (probation, profile, report, authority, coaching, performance, hiring). This is the §0 thesis made operational.

---

## 11. Execution Roadmap

Sequenced so each phase **makes the product feel more like hiring**, each unlocks the next, and trust precedes scale. Kernel frozen throughout — this is product + data + read-models riding intelligence that already exists.

### P0 — *Make it honest* ✅ DONE (2026-07-05)
Reachability · fail-loud · real analytics · enforced pause · correct cost · hand-back. **Why it mattered:** a product that lies cannot be trusted with a customer, let alone a business. This was the floor. It is shipped — and it is *not* the differentiation.

### P1 — *Make it feel hired* (the trust core — highest ROI in the product)
1. **Owner-visible probation ladder** [G-Prob] — move mode from env flag to a per-employee, watchable, reversible Shadow→Assist→Autonomous state. **Why:** it is the single largest lever on "I'd never let AI touch my customers." The machinery exists `[flags.ts:33]`; the product does not.
2. **The living Employee Profile** [G-Profile] — collapse nine config sections into one page that leads with *life*, hides config. **Why:** the owner's daily home must feel like a person, or nothing else lands.
3. **The Shift Report + colleague-altitude decision timeline** [G-Report, G-Explain] — the employee reports back, proactively, in plain language. **Why:** silence after launch is the fastest way to lose a new manager's trust.
4. **Authority as an earned envelope** [G-Auth] — money/irreversibility/reach limits with a track record and one-tap raises. **Why:** authority *is* the trust contract and the precondition for promotion; without it, "trust" has nothing to escalate.

### P2 — *Make it improve* (the flywheel and the moat)
5. **Coaching store + felt learning loop** [G-Coach, G-Learn] — every override/👎 becomes remembered coaching and a platform eval; show the override-rate-declining trend with pride. **Why:** this is the compounding trust signal *and* the data moat *and* the evidence that earns legacy deletion — three wins, one pipeline.
6. **Hire-from-a-job-posting** [G-Hire] — invert the wizard into a candidate you approve. **Why:** it defines the "employee, not software" feeling in the first five minutes; sequenced after the profile so the new hire lands somewhere alive.
7. **Performance record + reviews** [G-Perf] — KPIs and a review framed like a real one; analytics as a performance review, not a console. **Why:** owners manage to performance and buy outcomes/money, not token counts.
8. **Converge the copilot onto one brain** [G-Brain] — kill the strategy fork. **Why:** consistency is trust; divergence is a bug the owner eventually feels.

### P3 — *Make it scale* (the org)
9. **Roles as data** [G-Roles] — a `RoleDefinition` registry; the honest role library; the seed of a role marketplace. **Why:** the "hire any role in one click" pitch is hollow until roles stop being code.
10. **AI-native departments + shared knowledge/memory/policies** [G-Org] — turn the human-shaped org tree into an AI-native one.
11. **The AI Manager** [G-Org] — an employee whose customers are escalations; supervise the supervisor. **Why:** the only way 100 employees feels like fewer than 10.
12. **Offboarding + inheritance** [G-Retire] — an employee can leave without dropping a customer or a lesson. **Why:** trust in the exit is part of trust in the hire.

**Sequencing law:** trust before scale (nobody scales an employee they don't trust), and *feel* before *breadth* (a believable single employee beats a shallow library of ten). **P1 is where adoption is won or lost.**

---

## 12. The one-page truth

> GOTCHA built the **mind** of an AI Employee — a real reasoning kernel that decides before it acts and remembers every step `[graph: c16; schema: AgentLoopRun]`. What it has not yet built is the **self** and the **relationship**: an employee with a career (hired → probation → promoted → retired), an authority it earns, a memory of being coached, a performance record it's reviewed on, and a manager who watches it grow into a team.
>
> Every ❌ in §4, every P0/P1 gap in §10, and every principle in §2 points at the same work: **stop shipping a configurable agent; start shipping a colleague you manage.** The kernel is done. The moat is the employment relationship — and it is entirely buildable on the frozen architecture.
>
> **Build the self. Build the relationship. That is GOTCHA.**
