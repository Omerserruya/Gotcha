# AI Pipeline - Architecture Audit (Chief AI Architect Review)

**Date:** 2026-07-03 · **Scope:** the complete AI pipeline (incoming message → legacy brain / cognitive kernel → connectors → reply) · **Method:** independent repository exploration - kernel read line-by-line first-hand; incoming pipeline, legacy brain, and connector layer traced by three parallel deep-exploration passes; behavioral evidence from the live pilot + eval corpus. **This is an architecture review, not a code review.** Brutal honesty over protecting prior decisions.

---

## 0. Closure Log (findings closed since the audit)

| Finding | Closed | Evidence |
|---|---|---|
| **P0 HITL wiring** (risk #2; Runtime `approvalGate` stub) | 2026-07-03 | Kernel gate now wraps production `evaluatePolicies` + `createApprovalRequest` (calendar: BOOK→schedule_meeting / MOVE→reschedule / CANCEL→cancel, duration threaded for `on_condition`; CRM: UPSERT→integration_create_lead, ADD_NOTE→add_note; CRM write contracts flipped to `approval:"configurable"`; adapter surfaces the real ApprovalRequest id). Live-verified: 90-min BOOK → AWAITING_APPROVAL + real Approvals row + 0 events; idempotent across turns (no dup rows); 30-min → EXECUTED (legacy parity). Approval RESUME rides the existing approve→`dispatchApprovedAction` flow untouched. Tests: gate 5/5 hermetic; full suite 920 pass / 18 known-baseline. |
| **P0 Employee binding** (risk #4/#11; AIAgent config unenforced in kernel path) | 2026-07-03 | `buildEmployeeBinding(agent)` threads the AIAgent row into the kernel's existing slots - mission (role+goal+whatWeSell+ICP+disqualifiers), guidance (safetyBoundaries+forbiddenActions+customGuardrails+behavioralAnchors+successCriteria), persona (name/tone/doNots → Writer brandVoice only, never the decision). Deterministic/cache-safe. Tests 4/4 + live smoke green. |
| **P0 Memory persistence** (risk #5; `memoryUpdate` discarded) | 2026-07-03 | New `agent_customer_memory` table (migration applied) + `memory-store.ts` (fail-soft, bounded); the loop now captures `memoryUpdate` → `AgentLoopResult`; adapter loads per agent×customer before the loop and saves after (awaited, fail-soft). **Live-verified: memory row accumulates `priorReads` across 3 consecutive turns + `alreadyAsked`** - the contract's "becomes next turn's memory" is real. |
| **P0 Escalation side-effects** (risk #3; silent promises) | 2026-07-03 | `mapResult` raises a REAL escalation for every stuck termination (failed/blocked/max_iterations/timeout/budget_exceeded) with the last observation as diagnostic summary; shadow discards the object so evaluation can't leak side-effects. Tests 4/4 (incl. real ApprovalRequest id surfacing). |
| **P0 Billing fail-open** (risk #6) | 2026-07-03 | `readBilling` now falls back to LAST-KNOWN-GOOD per tenant (10-min TTL), never silently inventing "healthy"; cold-start-only permissive with loud warning (the metered AI choke point remains the hard backstop). Tests 3/3 - an exhausted tenant stays exhausted through a billing outage. |
| **P0 Anti-stall guard** (risk #7; loop §3.3 gap; dead `factsSignature`/`progressed` columns) | 2026-07-03 | After 2 consecutive identical (op, status, reason) non-EXECUTED outcomes the loop deterministically RULES OUT the op (judgment stays with the Reasoner - it re-reasons over the rule-out); `factsSignature` (sha1 of menu+world) + `progressed` now persisted. Test proves the book-full dead-loop class is cut at iteration 3 (was 6 → max_iterations). |
| **P1 Knowledge operation** (operation matrix gap; legacy R2) | 2026-07-03 | `SEARCH_KNOWLEDGE` wraps the production RAG (`retrieveRelevantChunks`, topK=5 parity): contracts + port + runtime + capability, registered with one line, zero kernel edits. Honest empty-result outcome ("treat as unknown - do not guess"). Tests 6/6. |
| **P1 CRM vocabulary completion** (operation matrix gaps) | 2026-07-03 | `GET_CUSTOMER_CONTEXT` (wraps `getCustomerContext`), `UPDATE_RECORD` (wraps `updateRecord`, sparse-patch contract preserved verbatim), `CREATE_TASK` (wraps `createTask`; production floor `always` respected - never auto-executes). LOG_ACTIVITY/CREATE_DEAL deliberately excluded: no vendor-neutral production implementation to wrap (appendInteraction is a pipeline concern; deals have no adapter method). Tests 27/27 CRM total. |
| **P1 Custom API/DB operations** (legacy R8/R9) | 2026-07-03 | `CustomCapability`: tenant-defined tools exposed as generic operations with their EXACT legacy names (`custom.<slug>`/`custom_db.<slug>`) so the production policy layer's dedicated custom-tool branch (risk-based floors) prices them natively - identity approval mapping. Dynamic per-tenant menu from `listCustomApiTools`/`listCustomDbQueryTools`; execution via the untouched production executors (host whitelist, template rendering, SQL/Mongo runners). Tests 6/6. |
| **P2 Dormant abstractions** (risk #18; simplification #4) | 2026-07-03 | Wire-or-delete executed: `MemoryStore` WIRED (the shared contract now has its DB-backed implementation, `agentMemoryStore`); the never-consumed `Agent` envelope (`assembleAgent`/`AgentRuntime`) and `grants.ts` (`AgentGrants`/`agentMayPropose`/`SpendLimits`) DELETED (~90 lines). `isAgentArchitectureEnabled` (used) retained. |
| **P2 Contract-home consolidation** (risk #20; simplification #9) | 2026-07-03 | `calendar.contracts.ts` moved out of shared into `services/ai/capability-runtime/` beside CRM/Knowledge contracts - ALL domain contracts now co-located; shared keeps only the generic contract types + resolver (the true kernel). 8 importers rewired; both packages `tsc` 0. |
| **P2 Writer session split** (adjacent to risk #10) | 2026-07-03 | The Writer now uses its own session key (`<conv>:writer`) - its prompt family no longer pollutes the Reasoner's prefix-cache telemetry/routing (`user` field). Positive cache-HIT telemetry added to the metering seam (health visible in both directions). |
| **P2 Reasoner menu preconditions** (Reasoner §3.2 gap) | 2026-07-03 | `businessPreconditions` now rendered in the operation menu - the Reasoner sees each operation's MUST preconditions (it previously never did), and the stable prompt head grows toward the 1024-token cache floor. |
| **P2 Prompt-cache optimization** (risk #10; REQUIRED, measured) | 2026-07-03 | Layout restructured stable-head-first: MISSION → GUIDANCE → OPERATIONS MENU (+preconditions) → CUSTOMER&PERMISSIONS (fixed per turn) above the fold; MONEY/WORLD/LOOP/MEMORY/CONVERSATION (volatile) below. **Measured - BEFORE:** 0% hit rate, dozens of documented `cached_tokens=0` misses, prefix drift between calls (volatile-first divergence < token 1024). **AFTER:** drift eliminated; stable head ≈1,792 tokens (measured; > 1024 floor); controlled A/B with a DIFFERENT conversation tail cached **1,792/1,841 tokens = 97.3%**, including cross-process cache reuse. Cost: cached input billed at the provider's cached rate → reasoner input cost on cache-warm calls drops by ≈ the cached fraction × provider discount (≈50–90% of input spend). Latency: −12% on the A/A pair (output tokens dominate reasoner latency, so gain is modest). Caveats: raw `spentUnits` (token counts) unchanged - the saving lands in billed cost via `cachedInputTokens` metering; a within-turn miss on one live run remains under observation (the controlled A/B proves the layout caches; live-loop hits also observed). Writer split to its own session key; positive cache-HIT telemetry added. |

---

## 1. Executive Summary

**The target architecture exists, is real, and is clean - but it is a passenger, not the driver.** The cognitive kernel (Oracle → Reasoner → Runtime → Connector → Observation loop) is implemented in ~2,959 lines against ~9,500 lines of legacy it is destined to replace, it is genuinely domain-agnostic (zero vendor or domain references in the cognitive layer - verified by grep and by a foreign-domain plug-and-play e2e), and its write path has been proven live against real Google Calendar and simulated CRM. **But it serves 0.0% of production traffic.** Every real customer turn is still decided by `generateAIBotReplyInner` - a 2,544-line function backed by a ~5,700-line deterministic decision stack (BEL, Objective Engine, NBA planner, prompt builder) that the kernel's single Reasoner subsumes but has not yet displaced.

The honest one-line assessment: **architecture ≈ 80% of target; production adoption ≈ 5%; employee-as-data ≈ 25% wired.**

Three findings matter more than everything else:

1. **The kernel's shape is right.** Adding CRM required zero kernel edits (proven twice - Commerce test domain, then real CRM). The Reasoner is vendor-swappable behind one seam. The Runtime is the sole executor with contracts-as-data and centralized invariants. The 10-year bet on this shape is sound.
2. **The Employee model is typed but not fed.** The kernel contract defines Role/Mission/Policies/Memory/Persona - and the `AIAgent` DB row already stores rich employee data (role, tone, persona, behavioral safety boundaries, salesContext, goal, successCriteria). But the adapter feeds the kernel only `businessDescription` + language. Cross-turn memory is produced by the Reasoner **every call and then discarded**. Persona, guidance/policies, goals, grants: all unwired. This is pure plumbing work - no kernel change needed - but until it's done, "employee defined by data" is a contract, not a reality.
3. **The remaining risk is concentrated in the last mile, not the kernel.** HITL approval is a stub in the kernel path (`approvalGate → required:false`) while legacy enforces it; `failed`/`blocked` terminations tell the customer "a team member will take it from here" without raising any escalation; billing checks fail open on error. None of these are architectural flaws - they are cutover blockers that must close before the kernel touches real traffic.

**Verdict preview:** approve the architecture as the permanent one; do **not** approve production cutover yet. The path to done is short and enumerated in §6 - it is wiring and evidence, not redesign.

---

## 2. Architecture Diagram - target vs. actual

### Target (the 10-year architecture)

```
Incoming Message
      ↓
   ORACLE  ── kernel facts (identity·billing·permissions) + world (per-capability self-description)
      ↓
  REASONER ── judgment only; emits structured intent; never calls tools
      ↓
 GUARDRAILS ── deterministic AUTHORIZE (money·permissions·menu)
      ↓
  RUNTIME  ── the ONLY executor; contracts-as-data; invariants; approval; trace
      ↓
 CONNECTOR ── generic Operation → vendor API (HubSpot, Google, …)
      ↓
 External System
      ↓
 OBSERVATION → ORACLE re-read → REASONER … → FINISH → WRITER (one voice, no tools)
```

### Actual (2026-07-03)

```
Incoming Message ─► webhook → incoming-worker → services/ai route
                                   ↓
                        generateAIBotReply (router)
                     ┌─────────────┴──────────────────────────────┐
                     ▼ 100% of production                          ▼ shadow only (fire-and-forget)
        LEGACY BRAIN (generateAIBotReplyInner, 2,544 ln)   COGNITIVE KERNEL (runAgentLoop)
        BEL → objectives → NBA → prompt → LLM+tools        Oracle → Reasoner → Guardrails →
        → orchestrator → 7 post-hoc gates → reply          Runtime → Connector → Observation → Writer
                     │                                             │
                     └────────────► CONNECTORS (17 vendor adapters + CRMAdapter×6 + gcal) ◄────┘
                                    (SHARED - both brains execute through the same leaves)
```

The two brains share the connector leaves (schedule-handler, booking-store, CRMAdapter) - the migration correctly wrapped rather than rewrote. The kernel diagram matches the target exactly; the problem is the left branch still exists and carries all traffic.

---

## 2.5 Responsibility Matrix - who owns what, today vs. target

| Responsibility | Target owner | Actual owner today | Status |
|---|---|---|---|
| World-state truth | Oracle | **Oracle (kernel path)** / crm-prefetch + ledger + fact snapshots (legacy path) | ✅ kernel / dual until cutover |
| Business judgment (what to do next) | Reasoner | **Legacy stack** (BEL + objectives + NBA) for 100% of traffic; Reasoner in shadow | ❌ not yet moved |
| Operation execution | Runtime (sole) | **Runtime for kernel + copilot calendar**; orchestrator + direct handlers for legacy dispatch | ⚠️ two executors until cutover |
| Authorization (money/permission/menu) | Guardrails (deterministic) | **Guardrails (kernel)**; policy pre-filter + tool-gate (legacy) | ✅ kernel / dual |
| Human approval (HITL) | Runtime approvalGate | **Legacy only** (orchestrator + hitlPolicy); kernel stub returns `required:false` | ❌ kernel gap - P0 |
| Escalation decision | Reasoner (judgment) | Legacy gates + **incoming-worker threshold checks** (a second decider) + Reasoner ESCALATE (shadow) | ❌ three deciders |
| Escalation side-effects (notify/handoff) | Kernel boundary | Legacy emit; kernel raises **nothing** on failed/blocked | ❌ P0 |
| Customer-facing expression | Writer (once, no tools) | **Writer (kernel)**; legacy: LLM prose + humanize + quality gates | ✅ kernel / dual |
| Cross-turn memory | AgentMemory store | **Nobody** - Reasoner emits `memoryUpdate`, adapter discards it; legacy has its ledger | ❌ P0 |
| Employee identity/persona/policies | Data (AIAgent row) → kernel binding | Data exists; consumed **only by legacy prompt builder** | ❌ binding missing - P0 |
| Vendor knowledge | Connectors only | **Connectors only** (verified: zero vendor refs in cognition) | ✅ done |
| Channel semantics (24h window, templates) | Pipeline policy / channel plane | Scattered: flow-executor + followup + legacy R4 | ⚠️ needs a declared home |
| Conversation routing (which brain) | Temporary migration floor | `agentLoopMode` + `agentKernelEligible` (explicit opt-in, routes nobody) | ✅ correct-by-design, temporary |
| Evidence/observability | agent_loop_runs + traces | **Kernel persistence + ExecutionTrace**; legacy audit rows in parallel | ✅ kernel superior |

## 3. Subsystem Audit

### 3.1 Oracle - **9/10**

`oracle-assembler.ts` (65 ln) + pure `assembleFacts` (shared, 83 ln). Owns world-state composition: kernel facts (identity, billing, permissions) + per-capability `CapabilityWorldView`, menu derived generically (union of capability ops ∩ RBAC), re-read **every iteration** - the loop never trusts an operation's return value, which is the single most important correctness property of the design, and it is enforced structurally.

- ✅ Truly generic: adding a capability changes nothing (verified - CRM registration touched zero Oracle code).
- ✅ No ambient clock; `asOf` passed in; pure composition separated from I/O reads.
- ⚠️ **Billing fails open:** `readBilling` catch → `{status:"active", withinLimits:true}`. A billing-service outage silently authorizes spend. Should fail toward a degraded-but-safe posture.
- ⚠️ Customer facts are thin: `knownFields` carries name/email/phone only since the 2026-07-02 fix; `entitlements.planFeatures` is always `[]` (plan features never threaded).
- ⚠️ Legacy still reconstructs reality in parallel (CRM prefetch, ledger, fact snapshots) for its own path - expected during migration, but it means two sources of truth exist until cutover.

### 3.2 Reasoner - **8.5/10**

`openai-reasoner.provider.ts` (194 ln) behind a vendor seam (`reasoner/index.ts` - add Claude/Gemini by implementing `ReasonerProvider`, nothing above changes).

- ✅ **Zero domain knowledge** - grep for calendar/CRM/booking/vendor terms in the reasoner: 0 hits. World rendered generically from capability self-descriptions.
- ✅ Reasoning centralized: the kernel path has exactly one decision-maker. Judgment is structured intent (discriminated union), uncertainty is a move (REQUEST_INPUT), never a score.
- ✅ Metered through the platform choke point - a Reasoner call can't bypass billing.
- ⚠️ **`memoryUpdate` is requested from the LLM in every call and then discarded** - wasted output tokens and the reason cross-turn continuity doesn't exist.
- ⚠️ Prompt is cache-hostile: static system prompt <1024 tokens + fully volatile user block → zero prefix-cache benefit; multi-iteration runs re-pay full input each time (observed drift warnings on every run; est. ~2× reasoner input cost at scale).
- ⚠️ Outside the kernel path, business decisions are still made everywhere (the whole legacy stack + escalation logic in incoming-worker) - reasoning is centralized *within* the kernel, not yet *within the product*.

### 3.3 Agent Loop - **8.5/10**

`agent-loop.ts` (358 ln) + pure `loop.ts`/`loop-policy.ts` (145 ln shared).

- ✅ Orchestration only - owns none of the four powers. Verified line-by-line: no business branching, no domain words. Termination taxonomy is principled: Reasoner-chosen vs guard-forced vs runtime-forced; BLOCKED and denials **re-enter** (giving up is a Reasoner decision, not a loop decision).
- ✅ Observations fed back correctly: neutral projection (`observation.ts`), invariant summary included, working memory accumulates deterministically, Oracle re-read after every execution.
- ✅ Per-capability tighten-only loop policy composition - data-driven safety bounds.
- ❌ **Stall detection is unwired.** `factsSignature`/`progressed` persistence columns exist but are always written `null`; there is no semantic no-progress guard. Empirically proven cost: the book-full incident re-proposed an identical failing op 6× to timeout (11.7k units) before the identity fix. `ruledOut` only captures DENIED/unrecoverable-FAILED - a repeating `NEEDS_INPUT` is never ruled out. Today the only protection is `maxIterations` (6).
- ⚠️ Dead vocabulary: `"blocked"` termination reason is never produced; loop-eval references a `"no_progress"` reason that doesn't exist.
- ⚠️ Latency envelope: 60s wall ceiling with observed 22–70s multi-iteration turns - near chat-UX limits; no per-iteration latency budget.

### 3.4 Runtime - **9/10**

Shared `resolveExecution` (pure resolver) + contracts-as-data + per-capability bindings (calendar.runtime 243 ln, crm.runtime 164 ln).

- ✅ Single executor: both brains and the copilot route calendar/CRM execution through the same resolver - "many minds, one hand" is real.
- ✅ Invariants centralized and principled: MUST/SHOULD × PRE/POST, satisfier-reads in operation space, probe-first optimization, structured `ExecutionTrace` on every execution (audit-grade WHY). Mode (autonomous/advisory) changes only the write effect, never authorization.
- ✅ No business decisions: the runtime gathers alternatives on failure, never chooses; a taken slot fails with `time_taken` rather than double-booking (verified live).
- ❌ **`approvalGate` is a stub (`required:false`) in both calendar and CRM bindings.** The legacy path enforces tenant HITL policies (e.g., approval for long meetings); the kernel path would silently skip them in autonomous mode. **Hard cutover blocker.**
- ⚠️ Contract duplication risk is low today (calendar contracts in shared, CRM contracts in services/ai - two homes for the same kind of data; should converge to one).

### 3.5 Connectors - **7.5/10** (see §7 for the full leakage scan)

17 vendor adapters self-register via an import side-effect registry; CRM is uniform behind `CRMAdapter` (6 vendors) resolved per-tenant. The cognitive layer has **zero vendor references** (verified). Both brains share the same connector leaves.

- ✅ True adapters: generic operation → vendor API; idempotency notes; token refresh handled by the framework.
- ⚠️ Calendar is effectively **Google-only** in the bookable path (details in §7) - the port abstraction is clean but only one vendor stands behind it.
- ⚠️ Two competing exposure models still coexist: legacy exposes vendor tools to the LLM (`integration_<slug>`, dotted vendor tools); the kernel exposes generic operations. Until legacy dies, every new integration must be wired twice or it's invisible to one brain.

### 3.6 Writer - **9/10**

101 ln; runs exactly once; no tools; metered; fail-soft to deterministic honest fallbacks; never claims false success. Clean. Two gaps: brand voice is plumbed in the signature but never passed by the loop; and the legacy path's output validators (booking-grounding, language lock) have no kernel equivalent - by design (the Runtime + honest intents replace them), but the language-mismatch case (customer writes English to a Hebrew-configured agent) is unhandled in the kernel path.

---

## 4. Operation Matrix

| Operation | Exists | Runtime-backed | Connector-backed | Shadow-ready | Autonomous-ready | Production-ready |
|---|---|---|---|---|---|---|
| CHECK_AVAILABILITY | ✅ | ✅ | ✅ Google (via schedule-handler) | ✅ evidenced (replay + outcome-eval, 100% safety) | ✅ live-verified | ⚠️ ready; not serving (flag) |
| BOOK_MEETING | ✅ | ✅ | ✅ Google | ✅ | ✅ live real write verified (insert+invite, invariants held) | ⚠️ ready; not serving |
| MOVE_MEETING | ✅ | ✅ | ✅ Google | ✅ | ✅ live real patch verified | ⚠️ ready; not serving |
| CANCEL_MEETING | ✅ | ✅ | ✅ Google | ✅ | ✅ live real delete verified | ⚠️ ready; not serving |
| SEARCH_CUSTOMER | ✅ | ✅ | ✅ CRMAdapter (6 vendors) | ✅ live-verified vs real HubSpot (read) | ✅ (read; sim + live) | ❌ shadow only |
| UPSERT_CUSTOMER | ✅ | ✅ | ✅ wraps `linkOrCreateCrmContact` (0/1/2+ reconciliation, merge → operator) | ✅ live-safe verified (RECOMMENDED, no mutation) | ⚠️ logic sim-verified; **real-vendor write unverified** (no disposable CRM; HubSpot write scopes unconfirmed) | ❌ |
| ADD_NOTE | ✅ | ✅ | ✅ wraps `createNote` | ✅ hermetic + shadow | ⚠️ sim-verified only | ❌ |
| CHECK_STOCK / PLACE_ORDER (Commerce) | test-only | ✅ (inline e2e) | in-memory | n/a | n/a | n/a - plug-and-play proof artifact |
| **Missing vs legacy tool surface** | - | - | - | - | - | SEARCH_KNOWLEDGE (RAG), GET_CUSTOMER_CONTEXT, UPDATE_RECORD, CREATE_DEAL, CREATE_TASK, LOG_ACTIVITY, close/followup/identity-link, custom-API tools, custom-DB tools, commerce/payment vendor tools |

**Reading:** the calendar family is done to production grade. CRM identity is built and shadow-safe but write-verification against a real vendor is deliberately deferred (user decision - disposable CRM). The long tail (~10+ operation families) is untouched: the kernel's operation vocabulary covers roughly **7 of ~40** tools the legacy brain can wield.

---

## 5. Legacy Matrix (verified against current code, 2026-07-03)

`generateAIBotReplyInner` = lines 1042–3586 (2,544 ln) of `ai-bot.service.ts` (3,792 ln). All R1–R25 confirmed present. Recent deletions (disabled dispatch gates, contract-violation recompute, ~196 ln) confirmed in-code.

| Responsibility (lines) | Verdict | Rationale |
|---|---|---|
| R1 BEL behavior decision (1257–1300) + behavior-engine.service (1,868 ln) | **DELETE** at cutover | Reasoner subsumes; kernel imports none of it |
| R2 KB retrieval (1301–1311) | **MOVE** | Needs a Knowledge capability (wrap RAG retrieval) - P1 build |
| R3 Memory/fact snapshot (1312–1323) | **MOVE** | Becomes AgentMemory persistence + Oracle customer facts |
| R4 WhatsApp 24h/templates (1324–1333) | **KEEP** (relocate) | Channel-plane concern, not cognition; belongs to the messaging pipeline or a CHANNEL world view - never the Reasoner |
| R5 Objective-engine feed (1334–1347) + objectives.ts (1,062 ln) | **DELETE** at cutover | Reasoner owns goals |
| R6 System prompt build (1348–1360) + prompt-builder (1,863 ln) | **DELETE** at cutover | Kernel renders from Facts generically |
| R7 Tool surface assembly (1361–1563) | **DELETE** at cutover | Menu derives from capability world-views |
| R8/R9 Custom API/DB tools (1564–1602) | **MOVE** | Needs a Custom-HTTP/DB connector + generic operations - P1 build |
| R10–R12 CRM adapter tools, semantic create, funnel stage (1603–1897) | **MOVE→DELETE** | CRM connector exists; remaining ops (context, update, deal, task) to add; funnel stage = employee data |
| R13 Reasoner-shadow hook (1944–1969) | **KEEP - delete LAST** | The evidence mechanism |
| R14 LLM tool loop + dispatch (2059–2310) + orchestrator (748 ln) | **DELETE** at cutover | The loop + Runtime replace both |
| R15/R16 contract enforcement / retry (2311–2470) | **DELETE** | Invariants own correctness |
| R17 Unit B action-preference re-roll (2472–2682) | **DELETE** | Loop re-reasoning replaces forced re-rolls |
| R18 Unit C failure recovery (2683–2899) | **DELETE** | Observation re-entry replaces it |
| R19/R20 objective-completeness + guaranteed bg actions (2900–3050) | **DELETE** / **NOT SURE** | Guaranteed CRM writes may deserve a declarative post-conversation policy instead of dying silently - decide at CRM cutover |
| Post-hoc regen gates: passive-close, booking fail-safe, grounding, ledger, redundant-info (3051–3442) | **DELETE** | Each encodes an incident the Runtime invariants + honest Writer now prevent structurally; keep each incident as an eval scenario before deleting |
| R25 decision trace (3443–3521) | **MERGE** | agent_loop_runs/iterations already supersede; keep one audit spine |
| Escalation emit + passive-close + humanize + quality audit (3522–3585) | **SIMPLIFY→MOVE** | Escalation side-effects must move to the kernel boundary (see risk #3); humanize/quality collapse into the Writer |
| planner.service (371) + plan-context (258) + copilot-tool-surface | **DELETE after copilot migrates** | Copilot is the second consumer keeping the planner alive |
| scheduling/schedule-handler/booking-store (1,626 ln) | **KEEP** | Integration leaves - the kernel wraps them (correctly) |
| crm-prefetch (455) / wizard-binding (121) / goal-evaluator (158) | **DELETE** at cutover (prefetch partially **MERGE** into CRM world view) | |
| Dormant kernel scaffolding: `assembleAgent`, `agentMayPropose`, `MemoryStore` (0 consumers) | **WIRE or DELETE** | Unused abstractions are how second architectures start |
| Migration scaffolding: operation-status ledger, flags, bot-loop-adapter, sim harnesses | **KEEP-temporary** | All marked with deletion conditions; die with legacy |

**Net:** ~9,500 lines are DELETE-at-cutover; ~1,700 are KEEP (integration leaves + channel semantics); the kernel that replaces the 9,500 is ~2,959.

---

## 6. Remaining Migration Roadmap

### P0 - cutover blockers (each is small; all are wiring/evidence, none is redesign)

| Item | Impact | Complexity | Depends on | Architectural importance |
|---|---|---|---|---|
| **Wire HITL into kernel** (`approvalGate` reads tenant hitlPolicy; AWAITING_APPROVAL already modeled end-to-end) | Without it, autonomous kernel bypasses human approval - safety regression vs legacy | S–M | none | HIGH - the contract already has the slot |
| **Escalation side-effects at kernel boundary** (`failed`/`blocked`/`timeout` terminations must raise a real escalation, not just say so) | Customer promised follow-up that never comes | S | none | HIGH - honesty contract |
| **Employee binding layer** (AIAgent row → AgentLoopInputs: persona, guidance/policies from behavioral+salesContext, goal, language per conversation) | Kernel replies currently ignore configured brand voice, forbidden actions, safety boundaries | M | none | HIGH - this *is* the employee-as-data promise |
| **AgentMemory persistence** (store `memoryUpdate` per agent×customer; stop discarding it) | No continuity; re-asks customers; wasted tokens today | S–M | none | HIGH - Memory is a pillar of the employee model |
| **Anti-stall guard** (rule out an op after N identical NEEDS_INPUT/observations, or wire the dead `progressed` columns) | Cost blowups; the book-full incident class | S | none | MEDIUM - pure loop hardening |
| **CRM write verification on a real vendor** (disposable CRM) - user-gated | Unlocks sales-employee cutover = the first real traffic | S (given sandbox) | external sandbox | HIGH - the traffic gate |
| **Loop-behavior evidence to significance** (scenario suite green + real-transcript corpus, outcome-judged) | The user's own gate for cutover | M (in progress) | eval apparatus (done) | HIGH |

### P1 - completes the platform

| Item | Impact | Complexity | Depends on |
|---|---|---|---|
| Knowledge connector (SEARCH_KNOWLEDGE wrapping RAG) | Unblocks support employees; removes R2 | M | none |
| CRM remaining ops (GET_CONTEXT, UPDATE_RECORD, CREATE_DEAL/TASK, LOG_ACTIVITY) | Full sales employee | M | CRM pattern (done) |
| Copilot → kernel advisory mode | Deletes planner/plan-context/copilot-surface; one brain for both products | M–L | kernel stable |
| Reasoner prompt cache restructure (stable ≥1024-token prefix) | ~2× reasoner input-cost reduction | S–M | none |
| RBAC/grants bridge (permissions ≠ allow-all; wire `AgentGrants`) | Multi-tenant rollout safety | M | cutover of pilot |
| Channel semantics as world view or pipeline policy (WhatsApp 24h) | Removes last KEEP inside the brain | M | none |
| First legacy deletions at cutover (BEL→prompt-builder→objectives→gates, family by family, evidence-gated) | The 9,500-line payoff | M (mechanical, gated) | cutover |

### P2 - scale & polish

Custom API/DB connectors as generic operations · additional calendar vendors behind the port · Commerce/payments operations · billing fail-closed posture + entitlement features threading · persistence retention/PII policy for facts snapshots · operation namespacing (capability-qualified names) · eval CLI consolidation · delete migration scaffolding + reasoner-shadow (LAST).

---

## 7. Incoming Pipeline & Connector Findings

### 7.1 Incoming message pipeline - **6.5/10**

Trace: channel webhook → `services/webhook` → `services/incoming-worker` → `POST /api/ai-bot/reply` (`services/ai/src/routes/ai-bot.ts:25` → `generateAIBotReply`) → reply dispatched back through the worker/outbound path.

The pipeline works, but it is **not clean by the target's standard: business decisions are made before and beside the brain**, in the worker:

1. **Escalation thresholds live in `incoming-worker/ai-bot.service.ts`** (`maxAutonomousMessages`/`maxAutonomousMinutes` checks + `escalateToHuman()` at :87–:105) - a second, deterministic escalation decision-maker outside any brain, historically kept in sync with the legacy brain's escalation logic by hand. Under the target architecture this is a Reasoner judgment (or at minimum a kernel-boundary policy), not worker code.
2. **`flow-executor.service.ts` (chatbot flows)** is a third decision-maker: it closes conversations, hands off to humans, assigns AI agents (`handledBy: "ai_agent"` :1330), sends WABA templates, and owns 24h-window re-opening. It is a legitimate separate product feature (deterministic workflows), but the boundary between "flow decides" and "employee decides" is implicit, not architectural.
3. **Channel semantics are scattered**: WhatsApp 24h window + template rules appear in the flow executor, the followup path, and legacy R4 - three homes, none of them a declared channel plane.
4. **"Should the bot reply at all"** (agent status, assignment, handledBy) is worker-owned - acceptable as pipeline policy, but undocumented as such.
5. **Prompt text is built inside the worker** for oneshot summarization calls (`ai-bot.service.ts:202` - including a "do NOT say a team member will reach out" instruction), i.e. prompt engineering outside `services/ai`.
6. **AI calls outside `services/ai`**: the two grandfathered exceptions (auth onboarding chat completions; knowledge-retrieval embeddings in the worker) - confirmed, no new leaks found.

Verdict: the pipeline stages are individually reasonable, but the target's "one brain decides" is violated at the edges: escalation caps, close/handoff, and channel rules are distributed decisions. At cutover these must be either (a) explicitly declared pipeline policy (data), or (b) folded into the kernel boundary - not left as parallel deciders.

### 7.2 Connectors - detail behind the 7.5/10

- **Inventory**: 17 vendor adapters (`google-calendar, hubspot, salesforce, shopify, stripe, paypal, square, wix, woocommerce, monday, airtable, fireberry, calendly, returngo, aws-rds, postgres, mongodb`) self-registering via import side-effect into `integration-framework.ts` (credentials load/refresh centralized, encrypted at rest). CRM is uniform behind `CRMAdapter` for **6 vendors** (HubSpot, Salesforce, Zoho, Shopify-as-CRM, Fireberry, Airtable) + a NoOp fallback, resolved per-tenant with a 30s cache.
- **Vendor leakage into cognition: zero.** Grep across agent-loop/, reasoner/, capability-plane/, shared capability-runtime: 0 code references to any vendor (verified first-hand). The Reasoner learns vendors only as opaque data (e.g. `crmVendor: "hubspot"` as a world fact - data, not code).
- **Calendar is Google-only in the bookable path.** The `CalendarPort` abstraction is clean, but only one vendor stands behind `schedule-handler.service.ts`; Calendly exists as an adapter but is not the booking path. Outlook/other calendars = new work behind the existing port (no kernel change - the port proves it - but the "multi-vendor calendar" claim is unproven).
- **The double-wiring tax is the main finding**: a new integration must today be wired as legacy catalog tools (to be usable by production) *and* as kernel operations (to be usable by the future). One vocabulary must win - and it should be the operations one.

### 7.3 Loop-behavior evidence (the readiness data behind §12)

From the eval corpus (n=72 autonomous runs over real transcripts + the 22-scenario behavioral suite, simulated connectors, real LLM): median **1 iteration**, avg 1.7; **zero hallucinated operations, zero runtime failures, zero authorization failures across all 72 runs**; 84.7% pathology-free. Known tail: repeated-ops ~11% (majority from pre-fix runs retained in the corpus; one genuine open case - repeated CRM identity ops - under investigation), plus orphan "running" rows from killed harness batches. The identity-threading fix demonstrated the apparatus works: book-full went 6 iterations/11.7k units/timeout → 2 iterations/4.1k units/finish. Evidence quality is good and improving; volume is not yet "hundreds of real conversations" because the pilot tenant only has ~24.

---

## 8. AI Employee Model - can an employee be pure data?

**Contract: yes. Reality: not yet.** The kernel types define exactly the target six-tuple - Role (`AgentIdentity.role`), Mission (`Context.mission`), Policies (`guidance` + `AgentGrants` + approval policy), Memory (`AgentMemory` + `MemoryStore`), Operations (capability menu), Connectors (per-tenant resolution). The `AIAgent` table already stores the data (role, tone, languages, persona, identity, behavioral safety boundaries, salesContext, goal, successCriteria). **Nothing about a new employee type requires code** - in principle.

What breaks the promise today (every one is adapter plumbing, none is kernel design):

1. `bot-loop-adapter` feeds only `mission.businessDescription = agent.goal || agent.name` + language. Persona, policies, goal, guidance: dropped.
2. `memoryUpdate` discarded → Memory pillar unimplemented (interface exists, no store).
3. `permissions.allowedOperations = []` (allow-all) and `AgentGrants` dormant → Policies pillar unenforced in the kernel path.
4. Employee "Available Operations" aren't derived from the agent's configuration (tool permissions) - the menu is world-derived only; per-employee operation scoping awaits the RBAC bridge.
5. A support employee would additionally need SEARCH_KNOWLEDGE + CREATE_TICKET operations that don't exist yet.

So: **a new employee type today = data + the missing binding layer**. Once P0 item 3 lands, Sales/Support/Reception/Finance differ only in rows.

---

## 9. Plug & Play Test - add Shopify / Monday / Jira / Zendesk tomorrow?

**Kernel path: yes, without touching cognition - proven twice.** The recipe is fixed: operation contracts (data) + port + prod-port wrapping a vendor adapter + bindings + `describeWorld` + one `registerCapability` line. The Commerce e2e proved a foreign domain runs on the unchanged kernel; the CRM connector proved it again on a real domain (zero edits to Reasoner/Oracle/Loop/Runtime, verified by the untouched 57-test kernel suite).

Couplings that remain (all below cognition, none in it):

1. **The registry line** - `capability-plane/index.ts` gains one import+register per capability. Acceptable (it *is* the plug), but a config-driven registration would remove even that.
2. **The legacy double-wiring tax** - until legacy dies, a new vendor must ALSO be wired as legacy catalog tools to be usable in production today. This is the strongest architectural argument for finishing the migration quickly.
3. **CRM-shaped assumption** - Jira/Zendesk (tickets) fit the pattern but need a new operation family (CREATE_TICKET…), not just a new adapter behind `CRMAdapter`. The pattern holds; the vocabulary must grow.
4. **Vendor adapter itself** - `connectors/<vendor>.adapter.ts` + catalog rows (unavoidable and correct).

---

## 10. Top 20 Architectural Risks (ranked)

1. **0% production traffic** - all kernel evidence is shadow/sim/pilot-harness; unknown-unknowns surface only at cutover. Mitigation is the agreed evidence program, then a narrow real cutover.
2. **HITL approval stub in the kernel path** - autonomous kernel would bypass tenant approval policies legacy enforces. Must close before any cutover.
3. **Silent escalation promise** - `failed`/`blocked` terminations produce "a team member will take it from here" with **no escalation raised** (`mapResult` only escalates on `escalate`).
4. **Employee safety config unenforced in kernel path** - `AIAgent.behavioral` (forbiddenActions, safetyBoundaries) lives only in the legacy prompt builder; kernel replies ignore it until the binding layer lands.
5. **Cross-turn memory absent** - re-asking customers, lost commitments; a CX regression vs legacy's ledger until AgentMemory persists.
6. **Billing fails open** in the Oracle on read error - money checks must fail safe.
7. **No stall guard** - identical failing proposals repeat to `maxIterations`; bounded cost blowup per stuck turn (observed 11.7k units) at scale becomes a real bill.
8. **Copilot is a second cognitive consumer on the legacy planner** - forgotten in most cutover plans; keeps ~2,500 lines alive after the chatbot migrates, and risks divergent behavior between employee and copilot.
9. **Dual-brain cost during shadow** - every shadowed turn pays two full LLM pipelines; no metering tag separates them; shadow at volume needs a sampling policy.
10. **Cache-hostile reasoner prompt** - ~2× input cost on multi-iteration runs, growing linearly with adoption.
11. **RBAC allow-all pilot posture** - safe for one trusted tenant, unsafe as a default; grants/permission bridge must precede broadening.
12. **Language selection** - kernel reply language comes from agent config, not per-conversation detection; cross-language conversations can get wrong-language replies (legacy had a language lock).
13. **Latency envelope** - 22–70s observed multi-iteration turns vs chat expectations; no per-iteration latency budget or streaming/interim-ack strategy in the kernel path.
14. **Operation-name collisions** - `deriveMenu` dedups by bare name across capabilities; two capabilities exposing `CREATE_TICKET` silently drop one. Needs namespacing before the vocabulary grows.
15. **Channel semantics unowned in the kernel** - WhatsApp 24h window/template rules live only in legacy/followup paths; a kernel-driven turn could violate them at cutover.
16. **PII in persisted facts snapshots** - every iteration stores full Facts (emails, phones); no retention policy.
17. **Sim-fidelity trap** - the eval program depends on simulated connectors; a low-fidelity sim already manufactured a false pathology once. Sims must answer the reasoner's actual question or evidence is polluted.
18. **Dormant abstractions** (`assembleAgent`, `AgentGrants`, `MemoryStore` - zero consumers) - unwired scaffolding invites a parallel second architecture; wire or delete.
19. **Guaranteed background CRM writes** (legacy R20) have no kernel successor decision - silent data-capture behavior may regress at cutover without an explicit call.
20. **Two contract homes** (calendar contracts in shared, CRM contracts in services/ai) - a growing inconsistency in where operation truth lives.

## 11. Top 20 Opportunities to Simplify (ranked by payoff)

1. Delete the legacy decision stack at cutover (~9,500 ln → already-built kernel) - the entire point.
2. Migrate copilot to kernel advisory mode → delete planner/plan-context/copilot-surface (~1,000+ ln) and reach true one-brain.
3. One operation-exposure model - retire the legacy tool-catalog surface so integrations are wired once, not twice.
4. Wire-or-delete the dormant Phase-1 types (agent.ts envelope, grants, MemoryStore).
5. Drop dead loop vocabulary + columns (`"blocked"` reason, `factsSignature`/`progressed`) or wire them (anti-stall).
6. Reasoner prompt reorder → stable cacheable prefix (cost, no architecture change).
7. Consolidate the two identity extractors (legacy `extractRecentEmail` vs adapter `extractLatestEmail`) into one shared util - duplicated during migration, one must die.
8. Collapse `TOOL_TO_OPERATION` maps (shadow-runner, calendar.execute) when copilot migrates.
9. One contract home - move CRM contracts next to calendar's in shared (or both to a `contracts/` plane).
10. Unify termination→side-effect mapping (reply, escalation, approval) in one boundary module instead of `mapResult` + Writer fallbacks.
11. Employee schema consolidation - `AIAgent`'s overlapping JSON blobs (identity/goals/toneConfig/behavioral/persona) → the six-field employee model the kernel consumes.
12. Channel semantics as data (a CHANNEL world view or pipeline policy), deleting the last cognition-adjacent special case.
13. Knowledge as a connector (wrap RAG) - deletes R2 and the strategy-gated retrieval branch.
14. Shared sim-connector module for the eval harnesses (currently 4 near-copies across scripts/tests).
15. Eval CLI consolidation (loop-eval + outcome-eval + traffic-share → one `kernel-eval` with subcommands).
16. Config-driven capability registration (kill even the one registry line).
17. Retire `generateAIBotOneshot` + `detectLocale` duplicates into shared utilities at cutover.
18. Merge `entitlements.withinLimits`/`billing.status` overlap into one money posture in Facts.
19. Post-conversation pipeline (summarizer/CRM writeback) as declarative post-turn policy instead of legacy-embedded behavior.
20. Delete migration scaffolding on schedule (operation-status ledger, flags, bot-loop-adapter, reasoner-shadow LAST) - each already carries its deletion condition; hold the line.

---

## 12. Final Scores & Verdict

| Subsystem | Score | One-line justification |
|---|---|---|
| Incoming pipeline | **6.5/10** | Functional, but escalation caps / close-handoff / channel rules are parallel deciders outside any brain |
| Oracle | **9/10** | Genuinely generic, re-read discipline structural; billing fail-open + thin identity facts |
| Reasoner | **8.5/10** | Domain-free, vendor-swappable, centralized; memory discarded + cache-hostile prompt |
| Agent Loop | **8.5/10** | Pure orchestration, correct termination taxonomy; stall guard unwired |
| Runtime | **9/10** | Single executor, contracts-as-data, invariants centralized, traced; HITL stub |
| Operations | **5/10** | 7 production-grade ops vs ~40-tool legacy surface; CRM writes vendor-unverified |
| Connectors | **7.5/10** | Uniform adapters, zero upward leakage; Google-only calendar, double-wiring tax |
| Migration | **6/10** | Evidence apparatus excellent, scaffolding disciplined; 0% traffic moved, deletions gated |
| **Overall architecture** | **8/10** | The 10-year shape is right and proven extensible |
| **Overall readiness** | **4/10** | Not serving production; P0 list is short but real |

### Final verdict

**Approve the architecture. Withhold production sign-off.**

The cognitive kernel is the right permanent architecture: it matches the target diagram exactly, it is provably domain- and vendor-agnostic, its execution authority is single and centralized, and its extensibility claim has been demonstrated rather than asserted. Nothing discovered in this audit argues for redesign - every finding is either wiring (P0), vocabulary growth (P1), or cleanup (P2).

But it is not yet an AI Employee platform. It is an excellent engine with: no memory, no persona, no policy enforcement, no approval gate, a 7-operation vocabulary, and zero production miles. The legacy brain - 9,500 lines of accumulated incident wisdom - still runs the business, and several of its unglamorous responsibilities (HITL, escalation side-effects, channel rules, safety boundaries) have no kernel successor yet. Those, not the architecture, are the real distance to done.

The fastest path to the 10-year architecture is not more architecture. It is: close the seven P0 items, cut one real employee over, and start deleting.
