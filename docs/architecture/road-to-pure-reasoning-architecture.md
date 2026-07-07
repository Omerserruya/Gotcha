# Road to Pure Reasoning Architecture

> Status: AUDIT / STRATEGY. No code. Brutally honest by request.
> Author: architecture audit, 2026-07-01. Evidence base: full pipeline reverse-engineering (webhook → reply), file:line cited inline.
> Governing rule: **complexity is a bug**. The smallest architecture that can run autonomous AI employees for SMBs for 5–10 years wins. No component is protected for being legacy; every component must justify its existence. No new component may be introduced merely because an old one is hard to understand — an existing component must be proven unable to evolve first.

---

## 0. The one-sentence thesis

Most of the current cognitive code exists to compensate for a model that could not be trusted to reason. It is **scar tissue from real 2025 (GPT-4o-era) production incidents**, frozen as deterministic heuristics. With a reasoning-grade model + authoritative facts + a constrained capability menu, ~70% of the cognitive code becomes an **eval corpus**, not runtime. Keep the guardrails that protect *money, permissions, correctness, and truth*. Delete the guardrails that were substituting for *judgment*.

---

## K. The Cognitive Kernel (designed from zero)

> Designed WITHOUT reference to today's code. Today's code is used only in §K2 as a completeness/minimality *test* of this kernel.

**Design axiom.** An employee is not code — it is **data** executed by ONE universal kernel. If two employees need two kernels, the kernel is wrong. The kernel is **fully deterministic except for a single sandboxed reasoning process**; everything the reasoner can do to the world is mediated by the kernel.

**Employee descriptor (pure data):** `{ Role, Mission, Capabilities[], Policies, Goal, Memory }`.

**Kernel state (per tick):**
- `Facts F` — verified world truth, recomputed every tick.
- `Working Set W` — mutable reasoning memory (evolving non-executable plan, hypotheses, ruled-out, observations, open needs).
- `Menu M` — operations available now = registered Capabilities ∩ Policies ∩ Facts, delivered to the reasoner as **data**.

**The 4 verbs (all cognition; nothing else is):**
1. **PERCEIVE** `(Employee, W) → F, M` — Oracle. Deterministic.
2. **DECIDE** `(Employee, F, W, M) → Decision` — Reasoner. The ONLY non-deterministic step. `Decision ∈ { PROPOSE(op, params, intent) | ASK(need) | FINISH(reason) | ESCALATE(reason) }`.
3. **EXECUTE** `(PROPOSE, mode) → Observation` — Runtime, with a **mandatory AUTHORIZE checkpoint** (Guardrails + Invariants) as precondition. `mode=autonomous`→perform · `advisory`→recommend.
4. **SPEAK** `(Employee, W, Decision) → Message` — Writer. Tool-less by construction.

**The loop (scheduler):**
```
W ← Memory
loop:
  (F, M) ← PERCEIVE
  D ← DECIDE
  if D ∈ {ASK, FINISH, ESCALATE}: break
  O ← EXECUTE(D, mode)     # AUTHORIZE gate inside; may deny or recommend
  W ← W ⊕ O               # fold observation, persist tick
                          # re-PERCEIVE next iteration — NEVER batch a plan
Message ← SPEAK(D)
Memory ← distill(W)
```
**Loop bounds (deterministic, not decisions):** max ticks · wall-time · AI budget · no-progress (goal-relevant Facts signature unchanged).

**The 9 laws (structural invariants):** (1) DECIDE is the only decider. (2) EXECUTE is the only effect. (3) Oracle is the only truth; DECIDE may never contradict F. (4) No EXECUTE without AUTHORIZE. (5) Re-PERCEIVE after every EXECUTE. (6) The reasoner sees Capabilities/Operations, never providers. (7) The reasoner may only propose from M. (8) `mode` changes only EXECUTE's effect — nothing else differs between autonomous and copilot. (9) Every tick is auditable (F snapshot + Decision + Observation persisted).

**Minimality proof (can't remove a verb):** remove PERCEIVE → hallucinated truth; remove DECIDE → no employee; remove EXECUTE → a chatbot, not an employee; remove/merge SPEAK → the decider gets a mouth+hands (unsafe). AUTHORIZE is EXECUTE's precondition, not removable. **4 verbs is the floor.**

**Universality proof (runs EVERY employee):** nothing in the loop or verbs branches on role. Role/Mission/Goal/Capabilities/Policies enter only as *data*. Sales{Calendar,CRM,Knowledge→book_meeting}, Support{Knowledge,CRM,Tickets→resolve_issue}, Research{Knowledge,Web→answer}, Voice{Voice,Calendar→book, SPEAK=TTS} are the SAME 4 verbs; only the descriptor + registered drivers differ. Copilot vs autonomous = the `mode` argument. **QED.**

**Not in the kernel (must never leak in):** providers (Google/HubSpot/Twilio) = capability drivers below EXECUTE; strategy/objectives/NBA = DECIDE's job; channel specifics = edge; role behaviors = Employee data.

## K2. Proof: today's code maps into the kernel (and reveals the scar tissue)

Every KEEPER maps to exactly one kernel slot. Every DELETION maps to **nothing** — it exists only because a weak model couldn't be trusted with DECIDE, or because EXECUTE was duplicated.

| Today's component | Kernel slot | Verdict |
|---|---|---|
| Oracle (`assembleFacts`, oracle-assembler, domain oracles) | **PERCEIVE** | KEEP/expand |
| Reasoner (provider, `parseReasonerOutput`) | **DECIDE** | KEEP/promote |
| Capability Runtime `resolveExecution` + Contracts + Invariants | **EXECUTE** envelope | KEEP |
| Guardrails (permissions, billing, approval, entitlements, budget, flags, `evaluatePolicies`) | **AUTHORIZE** | KEEP, 3 gates→1 |
| Writer | **SPEAK** | KEEP/evolve |
| Agent Loop (`agent-loop.ts`) | **the LOOP** | KEEP |
| Working Memory + LoopPolicy | **W + bounds** | KEEP |
| Capability Registry (`capability-plane`) | **M source + driver registry** | KEEP |
| calendar.capability / ports / provider adapters | **DRIVERS (below EXECUTE)** | KEEP, add CRM/Knowledge/… |
| AIAgent config row | **Employee descriptor** | KEEP/normalize |
| Booking store, CRM flags | **Facts inputs** | KEEP; committed-goal→Memory |
| Edge (webhook/workers/adapters/queues) | **I/O boundary (not cognition)** | KEEP |
| **BEL / Behavior Engine** | a deterministic DECIDE | **DELETE** (strategy→DECIDE; allowed-actions→AUTHORIZE) |
| **Objective Engine / NBA / objectives.ts** | a deterministic DECIDE | **DELETE** |
| **wizard-binding** | pre-DECIDE judgment | **DELETE** |
| **4 mini-loops** (retry/action-pref/recovery/guaranteed-bg) | violate law (5) | **DELETE** (the loop re-decides) |
| **5 quality-gate regens** | post-hoc DECIDE patches | **DELETE → evals** |
| **prompt-builder guardrails 1-14 / quality contract** | DECIDE-input prose | **DELETE → evals** |
| **tool-surface heuristic filtering** | ad-hoc Menu computation | **REPLACE** with `M = caps ∩ policy ∩ facts` |
| **ActionOrchestrator** | EXECUTE envelope + a gate | **MERGE** into Runtime front door + AUTHORIZE |
| **legacy dispatchToolCall + action-executor** | duplicate EXECUTE | **DELETE** (one Runtime) |
| **Copilot brain** (suggestResponse/chatWithAgent) | a 2nd DECIDE+LOOP | **DELETE** (mode=advisory) |
| **humanizeReply, session-fact extraction** | SPEAK / PERCEIVE detail | **MOVE/merge** |
| **`generateAIBotReplyInner`** | an ad-hoc kernel | **DELETE** (it is the thing being replaced) |
| **output-validator** | a SPEAK-time safety invariant | **KEEP** (slim) |

**Punchline:** today's system **= this kernel + ~6,000 lines of scar tissue + duplicated drivers.** No existing component reveals a *missing* kernel primitive → the kernel is **complete**. Every deletable component maps to *nothing* → the kernel is **minimal**.

**The one honest gap — positive obligations.** "Always create a lead when qualified" (today's guaranteed-background) is a *positive* obligation; Guardrails only do *negative* authorization. Resolve WITHOUT a new primitive: either (a) a **Policy stated to the reasoner** → it PROPOSEs the write (default), or (b) for money-critical integrity, a **deterministic post-tick reconciliation invariant** in the guardrail plane. Not a 5th verb. This is the single thing to watch during migration.

**Falsifiable test:** name an employee behavior GOTCHA must have that **cannot** be expressed as `Employee data + capability driver + Reasoner judgment + deterministic invariant`. If one exists, the kernel is incomplete. None is known.

## K3. Chief-Architect challenge round (self red-team)

Three corrections to §K after adversarial review. Two tighten the kernel; one admits a gap.

**A. The kernel was too reactive — add the Work Item (GAP, now fixed).** §K's loop was triggered by an *incoming message* = an *agent* model. An *employee* also does proactive/scheduled work (follow-ups, dunning nudges, "check back Tuesday", webhooks, human-assigned tasks). Fix, **no new verb**: the front door is a **Work Item** `{type, subject, employee, goalHint, payload}`; an inbound message is one *source* of Work Items (others: timer, event, assignment). The loop is unchanged; only the trigger generalizes. Revised loop head: `WorkItem → PERCEIVE → DECIDE → …`.

**B. Oracle survived a kill attempt, but its boundary shrinks.** Tempting collapse to 3 verbs: make *everything* a read-operation through EXECUTE (Facts = accumulated observations). Rejected because Law 3 ("never contradict truth") requires truth to be **present**, not pulled-on-request — a reasoner that must *remember* to read critical facts will reason on stale/missing ones; and money/permissions/entitlements must be **always present**. Resolution (tightens, doesn't grow): **Oracle = the always-present, cheap, CRITICAL baseline truth** (identity, entitlements, permissions, goal-state, capability menu, recent transcript). **Expensive/situational truth (CRM search, document fetch, order history) = a read-operation via the Runtime.** Still 4 verbs; the Oracle earns its keep as a *guarantee*, not a convenience.

**C. Writer is the weakest verb — earlier justification corrected.** I claimed Writer must be separate for *safety* ("don't give the decider a mouth+hands"). That is wrong: the Reasoner already cannot execute (it only *proposes*); emitting text is not executing a tool. The real justifications are separation of *what to say* (intent) vs *how to say it* (voice/persona/localization/channel formatting), a cheaper model, and channel rendering (WhatsApp `*bold*`, TTS, email HTML). Valid but weaker than the other three verbs. **On probation:** if one strong model does intent+phrasing+channel well, the Writer becomes a *mode of the DECIDE call*, not a component. Kept for now on cost + channel-formatting + testability.

**Revised kernel one-liner:** `Work Item → (PERCEIVE baseline truth → DECIDE → EXECUTE one op [autonomous|advisory] → observe → refresh)* → SPEAK`. Four verbs; proactive front door; Oracle scoped to guaranteed baseline truth; Writer explicitly justified on separation/cost, not safety.

---

## 1. Current architecture (as implemented)

Two processes. AI replies are sent **synchronously** from the worker and bypass the outgoing queue.

### 1.1 Edge (transport — `services/webhook`, `services/incoming-worker`, `services/outgoing-worker`)
`webhook.ts:42` verify+extract → enqueue `incoming-messages` → `incoming.worker.ts:157` dedup + persist INBOUND + upsert Conversation + route → `incoming-worker/ai-bot.service.ts:58` (**pre-AI escalation ceiling + human-keyword decisions**, `:97-107`) → `POST http://ai:4006/api/ai-bot/reply` (`:117`) → **sync** WhatsApp send (`whatsapp.adapter.ts:179`) + persist OUTBOUND.

### 1.2 Brain (`services/ai`, `generateAIBotReplyInner`, ~2,700 lines, `ai-bot.service.ts:1084-3833`)
A single mega-function running ~30 sequential stages:
- Deterministic **pre-LLM planning**: budget preflight (`:1129`), core context load (`:1185`), **Behavior Engine / BEL** (`behavior-engine.service.ts:377`) → strategy + allowed/required actions, KB/RAG (`:1359`), session-fact extraction (`:1398`), calendar capability compute (`:1426`), **tool-surface assembly + policy pre-filter** (`:1460-1893`), **Objective Engine / NBA** (`plan-context.service.ts:214`), giant **prompt-builder** (`:1975`).
- **Reasoner shadow** (`reasoner/shadow-runner.ts`, `:1993`) — dark, non-driving.
- **Main LLM loop, max 3 rounds** (`:2117-2533`) with in-loop **gates** (required inputs / exit criteria / allowed actions / contract order) → **ActionOrchestrator** (`action-orchestrator.ts:87`) → one of **three executor paths** → tool result pushed back as observation (`:2484`).
- **Four more mini-loops**: contract-retry (`:2535`), action-preference (`:2731`), failure-recovery (`:2942`), guaranteed-background (`:3222`).
- **Five quality-gate regens**: passive-close, booking-failsafe, grounding, unconfirmed-commit, redundant-info (`:3310-3694`).
- `humanizeReply` (`:3814`) → **output-validator** anti-fabrication (`:3817`) → persist → return. Up to **~12 LLM calls per turn.**

### 1.3 Parallel/dormant assets (already built this cycle)
- **Oracle**: `assembleFacts` (`oracle.ts`) + `oracle-assembler.ts` + domain oracles (calendar, billing).
- **Reasoner contract + provider**: `reasoner-provider.ts` + `openai-reasoner.provider.ts` + strict `parseReasonerOutput`; **shadow eval corpus** (`reasoner_shadow_evals`) + agreement dashboard.
- **Agent Loop**: `agent-loop.ts` (reason→execute→observe→re-oracle→repeat), Working Memory, per-capability LoopPolicy, goal-based progress, Writer — flag-gated (`AGENT_LOOP_MODE`, off).
- **Capability plane**: registry (`capability-plane/`) + Capability Runtime (`resolveExecution`) + Contracts + Invariants.

**The uncomfortable truth:** the target architecture is ~60% already built (dormant), sitting behind a flag, next to a 2,700-line legacy brain that is still production.

---

## 2. Future architecture (target) — the AI Employee model

We stop thinking "AI Agent." We build **AI Employees**. An Employee is defined ONLY by:

**Employee = {Role, Mission, Capabilities, Policies, Current Goal, Memory}.** Everything else emerges from reasoning. Nothing else is configuration.

One loop, one brain. Execution mode is the only autonomous/copilot difference.

```
Message → Oracle(truth) → Reasoner(decides: goal? missing info? next intent? done?)
        → {Working Goal, Working Plan (evolving memory), Next Intent+Operation}
        → Request Compiler (deterministic: normalize/enrich → ExecutionRequest)
        → Guardrails (deterministic: authorize) → Capability Runtime (execute | recommend)
        → Observation → Oracle(refresh) → Reasoner → … → FINISH → Writer → Customer
```

**Ownership (inviolable):** the Reasoner **decides**, the Guardrails **authorize**, the Runtime **executes**, the Oracle provides **truth**, the Writer **communicates**. No other component owns a business decision.

**The Working Plan is not executable.** It is evolving working **memory** — the Reasoner may add, remove, rewrite, or abandon it at any iteration. It is never a workflow, never deterministic logic. Reasoning happens after **every** Runtime execution against the refreshed Oracle.

**One brain, two modes:** the Capability Runtime already parameterizes `ExecutionMode` and short-circuits writes to `RECOMMENDED` in advisory mode (`resolver.ts:179`). **Copilot = the same loop with `mode=advisory`** (operations become recommendations); Autonomous = `mode=autonomous` (operations execute). Oracle, Reasoner, Working Memory, Capability Registry, Runtime, Agent Loop are **identical**. The separate copilot brain (`suggestResponse`/`chatWithAgent`) is deleted, not maintained.

### 2.1 The Planner question — collapse it (decided)

Challenge: should the "Planner" become a pure execution compiler? **Verdict: there is no Planner and no task-compiler component. Collapse both.** The reasoning:

**Business reasoning vs execution planning is a distinction between two FIELDS of one decision, not two components.** The Reasoner emits, in one structured decision:
- a business **intent** in plain language ("I need to know if there's availability") — stored in Working Memory + audit, never executed; and
- the **operation** it selects from the **live capability menu** (`CHECK_AVAILABILITY` + meaning-level params).

Selecting the operation **is judgment** and therefore belongs to the Reasoner. Proof by the user's own constraint (the translator must contain *zero* business reasoning):
- If task→operation is **1:many**, choosing is a business decision → the compiler may not do it → it must be the Reasoner.
- If task→operation is **1:1 deterministic**, "task" and "operation" are the same thing renamed → a component that does a 1:1 rename doesn't justify its existence.

A layer that both *picks operations* and *contains no reasoning* is a contradiction. And naming a component "Planner" invites business logic to accrete there — **exactly how today's Objective Engine grew into 2,700 lines.**

**What remains is the Request Compiler** — a deterministic *phase* at the Runtime's front door, not a component: normalize params (`"tomorrow 5pm"→ISO`), enrich context (tenant/customer/ids), package the `ExecutionRequest`. It knows no goals, no strategy, no workflows. Its ancestor already exists as the Runtime's PRE-invariant + satisfier + request-construction phase (`resolver.ts:135-176`). It earns its name as a *phase*, not a service.

### 2.1a Provider-shielding + plug-and-play (the mechanism)

The Reasoner never knows providers — only Capabilities (Calendar, CRM, Messaging, Knowledge, Payments, Commerce, Voice) and their Operations. This is achieved by **delivering the operation menu to the Reasoner as DATA every turn** from the Capability Registry (business-language descriptions, meaning-level params). Consequences:
- Adding Shopify / Outlook / Salesforce = **register a Capability implementation** (Contract + strategy/adapter + optional oracle) → its operations appear in the menu → the Reasoner uses them with **zero Reasoner code change**. True plug-and-play.
- The Reasoner hardcodes no operation names and can only propose **from the live menu** — so it can **never propose an unsatisfiable task**. The menu *is* the boundary of the possible. (A free-form "task" layer would reintroduce the ability to ask for the impossible and then need logic to handle it — strictly worse.)
- A **need the Reasoner cannot satisfy** (e.g. "I need payment status" with no Payments capability registered) is captured in **Working Memory** (`openQuestions`/blocked) → the Reasoner FINISHes-with-reason or ESCALATEs. It is memory, never an execution. This is the *one* place the raw "intent" concept lives — and it belongs in memory, not a compiler.

### 2.2 Final component set (each justified — smallest possible)
1. **Oracle** — verified world-state truth. Irreducible. Deterministic.
2. **Reasoner** — ALL business decisions (goal · missing info · next intent+operation · done?). The one brain.
3. **Working Memory** — the state the Reasoner mutates: the evolving non-executable Working Plan **plus** cross-turn `Memory` continuity. Evolve existing `WorkingMemory`; do **not** build new.
4. **Capability Registry** — the operation menu delivered to the Reasoner *as data*; decouples cognition from providers. Irreducible.
5. **Request Compiler** — a *phase*, not a component: deterministic normalize/enrich → `ExecutionRequest`, from the Runtime's existing PRE/satisfier front door (`resolver.ts:135-176`). **No separate Planner. No task-compiler.**
6. **Guardrails** — deterministic authorization plane between proposal and execution: permissions, billing, approval/HITL, tenant entitlements, enabled capabilities, subscription, AI budget, feature flags. The Reasoner may *propose* anything; Guardrails decide if it is *allowed*.
7. **Capability Runtime (+ Contracts, Invariants)** — the sole executor + correctness envelope. Protected. Providers/strategies live *below* it, invisible to cognition.
8. **Writer** — communication only; no tools by construction.

Six cognitive parts (Oracle · Reasoner · Working Memory · Capability Registry · Runtime · Writer) + two deterministic planes (Request Compiler *phase*, Guardrails). The Agent Loop *orchestrates* this set; it owns no decisions. Everything in §4 collapses into these.

**The owners, restated:** the **Reasoner decides**, the **Guardrails authorize**, the **Runtime executes**, the **Oracle knows the truth**, the **Writer speaks**. Nothing else may own a business decision. **Copilot vs Autonomous = execution mode only**; all six parts are identical.

---

## 3. Component responsibility matrix

Legend — Decides (business decision) · Truth (reads world state) · Mutates (writes world state) · Verdict ∈ {KEEP, SIMPLIFY, MOVE, REPLACE, DELETE}.

| Component (file) | Responsibility today | Decides | Truth | Mutates | Verdict | Rationale |
|---|---|---|---|---|---|---|
| Webhook / queues / adapters | Transport | No | No | Yes(msg) | **KEEP** | Pure I/O, not cognition. |
| `incoming.worker` routing | Dedup, persist, route | Yes(routing) | Yes | Yes | **SIMPLIFY** | Keep transport+persist; move AI-vs-human routing intent toward the loop. |
| Worker pre-AI escalation/human-keyword (`incoming-worker/ai-bot.service.ts:97`) | Escalate before AI even runs | **Yes** | Yes | No | **MOVE→Reasoner** | A business decision living outside the brain. Becomes a Reasoner ESCALATE / Policy. |
| Budget preflight / billing enforcement | Gate turn on credits | Yes | Yes(wallet) | No | **KEEP** | Money is a Fact, never negotiable. Bounds the loop. |
| Core context load (`:1185`) | Assemble world state inline | partial | Yes | No | **REPLACE→Oracle** | Duplicated truth assembly. The Oracle is the single source. |
| **Behavior Engine / BEL** (`behavior-engine.service.ts`) | Strategy state machine, allowed/required actions, tone | **Yes (sole gate today)** | Yes | No | **DELETE** | The flagship GPT-4o crutch. Strategy = reasoning (→Reasoner); gating = capability menu + policy facts; tone →Writer. |
| **Objective Engine / NBA / objectives.ts** (`plan-context.service.ts`) | Deterministic objective chain + next-best-action ranking | **Yes** | Yes | No | **DELETE** | Planning the model couldn't do. Replaced by Working Plan + Reasoner. Goal is now an input. |
| `goal-evaluator` (GoalStatus derived) | Is the goal achieved? | No | Yes | No | **MOVE→Oracle** | Useful as a derived **fact**; delete the objective-ID branching. |
| `wizard-binding.service` (LLM fit/qualification judgment) | Pre-compute fit/qualification | **Yes** | Yes | No | **DELETE/MOVE** | LLM judgment as a pre-step = the Reasoner's job. Delete; Reasoner infers from Facts+Mission. |
| Tool-surface assembly + heuristic filtering (`:1460`) | Which tools to offer | Yes | Yes | No | **REPLACE** | Capability menu from registry ∩ Oracle permissions. Delete heuristics. |
| **Giant prompt-builder** (6+ sections, guardrails 1-14, quality contract) | Compose mega-prompt | No | Yes | No | **REPLACE** | Replaced by lean Reasoner prompt (Facts+Capabilities+Plan+Mission+Policies). The 14 guardrails → eval cases. |
| Main LLM loop (`:2117`, 3 rounds) | Iterative tool calling | Yes(LLM) | Yes | Yes | **REPLACE→Agent Loop** | A real loop already — but tangled with heuristics. Superseded by `agent-loop.ts`. |
| In-loop gates (required/exit/allowed/contract) | Structural validation | No | Yes | Blocks | **SIMPLIFY→Execution Planner/Contracts** | "required inputs" = contract PRE-invariants. Consolidate into the Runtime front door. |
| 4 mini-loops (contract-retry, action-pref, failure-recovery, guaranteed-bg) | Force/retry actions | No | Yes | Yes | **DELETE** | Patches forcing a weak model to act. Reason-after-every-execution removes the need. (Guaranteed-bg → Policy; see Risks.) |
| 5 quality-gate regens (`:3310-3694`) | Post-hoc reply correction | No | Yes | Reply | **DELETE→evals** | Anti-hallucination scar tissue. Grounding is solved by authoritative Facts. Convert each to a regression eval. |
| `humanizeReply` | Strip dashes/style | No | No | Reply | **MOVE→Writer** | Communication style is the Writer's. |
| **output-validator** (anti-fabrication vs ledger) | Last-line safety | Yes(safe deflect) | Yes(ledger) | Reply | **KEEP/SIMPLIFY** | Legit defense-in-depth (security), not a reasoning crutch. Slim it. |
| session-fact extraction / `resolveSessionKnowledge` | Language-aware fact keys | No | Yes | No | **DELETE** | Existed only to feed the objective engine's English-key matcher. That reason dies with the objective engine; Reasoner reads the transcript. |
| KB retrieval / RAG (`knowledge-retrieval.service`) | Fetch knowledge | No | Yes | No | **MOVE→Knowledge capability** | Becomes a `RETRIEVE_KNOWLEDGE` operation the Reasoner invokes (or Oracle pre-fetch). Not an always-on pre-step. |
| **ActionOrchestrator** (`action-orchestrator.ts`) | Policy + dedup + idempotency + retry + breaker | Yes(gate) | Yes(redis) | Yes(TER,approval) | **MOVE/MERGE→Runtime** | Its durable concerns are deterministic and belong in the Runtime/Execution Planner. Delete the legacy-dispatch wrapper. |
| `dispatchToolCall` (legacy, `agent-tools.ts`) | Legacy tool dispatch + own gate | Yes | Yes | Yes | **DELETE** | Collapse 3 executors → 1 (Capability Runtime). |
| `action-executor.service` (legacy, direct) | Post-chat/direct execution + own gate | Yes | Yes | Yes | **DELETE** | Second legacy executor + third policy gate. |
| Capability Runtime `resolveExecution` + Contracts + Invariants | Execute with correctness envelope | No | Yes | Yes | **KEEP** | Strategic. The sole executor. Protected. |
| Capability Registry (`capability-plane/`) | Menu + routing + oracle + policy | No | Yes | No | **KEEP** | The decoupling layer. (Rename note: dir is `capability-plane` to avoid `capabilities.ts` file collision.) |
| Oracle (`assembleFacts`, `oracle-assembler`, domain oracles) | Assemble verified world state | No | Yes | No | **KEEP/EXPAND** | Add CRM/Knowledge/Payments domain oracles. |
| Reasoner (`reasoner-provider`, provider, `parseReasonerOutput`) | Decisions (currently shadow) | **Yes** | reads Facts | No | **KEEP/PROMOTE** | Becomes the one brain. Strict decision parsing stays. |
| Reasoner shadow corpus + dashboard | Parity measurement | No | No | Yes(evals) | **KEEP (transitional)** | The instrument that proves the cutover is safe. Retire post-migration. |
| Agent Loop + Working Memory + LoopPolicy + Writer | The cognitive loop | Yes(via Reasoner) | Yes | Yes | **KEEP/EVOLVE** | Add mutable Working **Plan** (add/remove/rewrite steps); LLM Writer. |
| Policies / Permissions / tool-gate / `evaluatePolicies` | Authorization | Yes(authz) | Yes | No | **KEEP/SIMPLIFY** | Protected. Consolidate 3 policy gates → 1. |
| Billing / entitlements | Capacity/limits | Yes | Yes | Yes(meter) | **KEEP** | Protected. |
| Audit / usage / decision trace | Observability | No | Yes | Yes | **KEEP** | Protected. Loop already persists iterations. |
| Copilot brain (`suggestResponse`, `chatWithAgent`, `assembleCopilotToolSurface`, `routeCopilotTool`) | Second brain for advisory | Yes | Yes | No | **DELETE/MERGE** | "One brain" mandate. Same loop, `mode=advisory`. |
| Cross-turn memory (bot_turn metadata, committed goal, booking store, crm flags) | Continuity | Yes | Yes | Yes | **SIMPLIFY/UNIFY** | Split cleanly: Oracle (truth) + Working Memory (intra-loop) + one durable continuity store (committed goal). |

---

## 4. Things that should DISAPPEAR entirely

1. **Behavior Engine / BEL strategy machine** — strategy is reasoning.
2. **Objective Engine + NBA + objectives.ts** — planning is the Working Plan + Reasoner.
3. **wizard-binding LLM judgment pre-step** — qualification is reasoning.
4. **The 4 mini-loops** (contract-retry, action-preference, failure-recovery, guaranteed-background) — reason-after-every-execution replaces all forcing/retry logic.
5. **The 5 quality-gate regens** — become regression evals, not runtime.
6. **`humanizeReply` + the giant prompt-builder's guardrails 1-14 / quality contract** — Writer + evals.
7. **session-fact extraction pre-step** — Reasoner reads the transcript.
8. **Legacy executors: `dispatchToolCall` + `action-executor`** — one Runtime.
9. **Two of three policy gates** — one gate.
10. **The separate Copilot brain** — one loop, advisory mode.
11. **`generateAIBotReplyInner` itself** — the 2,700-line orchestrator is replaced by the loop.

Rough deletion budget: **~5,000–8,000 lines of cognitive heuristics**, which matches your stated willingness.

---

## 5. Things that must remain DETERMINISTIC (the guardrail plane)

The Reasoner is probabilistic; these wrap it and may never be delegated to it:
- **Capability Runtime execution + Invariants** (correctness envelope — a MUST invariant is world-state-verified regardless of what the model "believed").
- **Permissions / RBAC** and **Approval / HITL** gating.
- **Billing / entitlements** enforcement (hard block at zero; never negative).
- **Idempotency / dedup** (no double-booking, no duplicate CRM records across redeliveries).
- **Audit** (every decision + execution traceable).
- **Oracle fact derivation** (truth is computed, never generated — the Oracle must be deterministic or the whole model of "authoritative Facts" collapses).
- **Output-safety validation** (anti-fabrication vs the real action ledger — a security control).

---

## 6. Things that should MOVE INTO the Reasoner

Every "what should happen" decision currently frozen as a heuristic: strategy selection, goal/objective planning and re-planning, qualification/fit, escalation decisions, action selection & sequencing, retry/recovery choices, when to retrieve knowledge, when to ask vs act, when to finish. The Reasoner emits *decisions*; the guardrail plane says *no* when a decision is unsafe.

---

## 7. Deletion roadmap (order matters — delete only what the loop already covers)

1. **Unify executors → Capability Runtime.** Give CRM / Knowledge / Payments / Messaging real Contracts + bindings + oracles in the capability-plane. Then delete `dispatchToolCall` and `action-executor`, and collapse the 3 policy gates into the Runtime front door. *(Enables everything else — until the Runtime can execute all capabilities, the loop can't replace the legacy path.)*
2. **Promote the Oracle** as the single truth source; delete inline core-context assembly + session-fact extraction; fold `goal-evaluator` in as a derived fact.
3. **Cut the brain over** (behind the existing flag, shadow-proven): route the turn to the Agent Loop; delete BEL, Objective Engine/NBA, wizard-binding, tool-surface heuristics.
4. **Delete the compensation layer**: 4 mini-loops + 5 quality-gate regens + humanizeReply; move their intent into the Reasoner prompt and into the **eval corpus**.
5. **Replace the prompt-builder** with the lean Reasoner prompt; retire guardrails 1-14 as evals.
6. **Merge Copilot** into the loop via `mode=advisory`; delete the second brain.
7. **Retire `generateAIBotReplyInner`** and the shadow scaffolding once agreement + eval pass.

## 8. Migration roadmap (safe cutover, uses assets already built)

- **Instrument (done):** Reasoner runs in shadow; `reasoner_shadow_evals` + agreement dashboard measure Planner↔Reasoner parity per turn.
- **Convert scar tissue → evals:** each guardrail/quality-gate/mini-loop maps to a named regression case (the real incident it was born from). This is the safety net that lets us delete the runtime heuristic.
- **Advisory-first per capability:** turn the loop on in `advisory` mode for a pilot tenant + one capability (Calendar, already contracted). Watch iterations in `agent_loop_iterations`.
- **Autonomous per capability:** flip to `autonomous` once agreement-rate + evals hold. Expand capability by capability (Contracts are the unit of migration).
- **Delete per §7** only after the corresponding loop coverage is green. Never delete ahead of coverage.

## 9. Risks (brutally honest)

- **The heuristics encode real incidents.** Guardrails 1-14, the 5 regens, guaranteed-background CRM writes, "no Saturday booking," Hebrew-leak, don't-re-ask — these are production scars. Deleting them **assumes the Reasoner won't regress**. Mitigation: they become **evals**, and shadow parity must cover them *before* deletion. This is the #1 risk; treat the eval corpus as a hard gate.
- **CRM integrity determinism (guaranteed-background).** Today a ripe lead/deal is force-written regardless of the model. A pure reasoner might skip it. Mitigation: express it as a **Policy/post-condition** ("if qualified and no lead exists → BOOK/UPSERT is mandatory"), enforced by the guardrail plane, not model goodwill.
- **Cost & latency.** Reason-after-every-execution multiplies LLM calls. This is intentional and non-negotiable per the vision — but real. Mitigation: bounded LoopPolicy, prompt caching (stable Facts/Capabilities prefix), model tiering (cheap for narration, strong for decisions), and the fact that deleting ~12-call compensation loops recovers much of the budget.
- **Oracle correctness becomes existential.** If Facts are wrong, the Reasoner is confidently wrong. Mitigation: Oracle stays deterministic, re-reads after every execution, and Invariants re-verify at execution time.
- **Single brain, single failure mode.** One reasoner error surface for both autonomous and copilot. Mitigation: this is a feature (one thing to make excellent), plus the guardrail plane + output-validator.
- **Big-bang temptation.** The clean end-state invites a rewrite. Mitigation: the capability-by-capability, shadow-gated migration above — the Contract is the migration unit, not the calendar/whole-brain.

---

## 10. Verdict

If we started GOTCHA today: **Oracle + Reasoner + Working Plan + Capability Registry + Capability Runtime + Writer**, wrapped by a **deterministic guardrail plane** (Policies, Billing, Permissions, Audit, Invariants, Idempotency, Output-safety). One loop. One brain. Mode is the only autonomous/copilot difference.

That architecture is largely **already built and dormant**. The work ahead is less "build the future" and more **"delete the past safely, capability by capability, gated by evals and shadow parity."** The single most important discipline: **never delete a heuristic until its incident lives as an eval and the Reasoner passes it in shadow.**
