# AI Employee Platform — Production-Grade Architecture Review

> **Date:** 2026-07-05 · **Branch:** `feat/customer-intelligence-phase1`
> **Mission:** complete end-to-end validation of the AI Employee lifecycle — creation, brain, modes, owner experience, role skills, E2E product.
> **Evidence base:** six deep part-audits with file:line verification, in `.omc/autopilot/audit/`:
> [part1-creation](../../.omc/autopilot/audit/part1-creation.md) · [part2-brain](../../.omc/autopilot/audit/part2-brain.md) · [part3-modes](../../.omc/autopilot/audit/part3-modes.md) · [part4-experience](../../.omc/autopilot/audit/part4-experience.md) · [part5-roles](../../.omc/autopilot/audit/part5-roles.md) · [part6-e2e](../../.omc/autopilot/audit/part6-e2e.md)
> Companion decided-target docs: `road-to-pure-reasoning-architecture.md`, `reasoner-architecture.md`.

---

## 1. Current Architecture Map

```
CUSTOMER MESSAGE
  → services/webhook          (200-first, HMAC verify when possible, queue handoff)
  → services/incoming-worker  (dedup, persist, profile/media fetch, ownership gate,
                               EDGE BRAIN: escalation ceilings + human-request regexes [duplicated])
  → services/ai  POST /api/ai-bot/reply
        ├─ MODE ROUTER (ai-bot.service.ts:846-878): AGENT_LOOP_MODE off|shadow|autonomous
        │
        ├─ LEGACY BRAIN (customer-facing today) — generateAIBotReplyInner (~2,700 lines)
        │    context assembly (~15 serial steps, 2 blocking micro-LLM calls)
        │    → 16k-token 6-block prompt (prompt-builder, 1,863 lines)
        │    → main loop ≤3 rounds → 4 mini-loops → 5 regen passes → humanize → output-validator
        │    → audit (ai.bot_turn with toolCalls/goal/behaviorState) — worst case ~21 LLM calls/turn
        │
        ├─ TARGET BRAIN (kernel; CALENDAR autonomous for pilot agents, rest shadow)
        │    Oracle (assembleFacts: kernel signals + CapabilityWorldViews, menu = ops ∩ RBAC)
        │    → Reasoner (mode-blind ReasonerInput, strict JSON decision)
        │    → Guardrails (pure DENY: billing/budget/permission/menu)
        │    → Capability Runtime (contracts-as-data → PRE invariants → approval → strategy → POST + success)
        │    → Observation → re-Oracle → … (≤6 iters, 60s) → Writer (1 metered call, fail-soft)
        │    persistence: agent_loop_runs/_iterations (replayable facts snapshots)
        │
        └─ SHADOW EVAL (decision-parity corpus reasoner_shadow_evals, replayable, dark)
  → reply sent DIRECTLY via channel adapter (bypasses outgoing queue)
  → HUMAN TAKEOVER: isHandedOver/assignedAgentId gate (one-way today)

CREATION: /ai-studio AgentBuilder (conversational wizard, 4 steps, draft/resume,
readiness report) → AIAgent row ACTIVE → **routing never wired** → FlowCanvas decides
COPILOT: ai-assist suggestResponse/chatWithAgent — shared plan, BEL-forked strategy + reduced surface
BILLING: generateResponse choke point → usage_logs + AI-Units metering (mode=off by default)
OBSERVABILITY: rich write-side corpus (audit/loop/shadow/usage) — near-zero read APIs/UI
```

Five mode vocabularies coexist (AgentLoopMode, ExecutionMode, AIWorkerMode [dormant], BEL AgentMode, conversation ownership) plus one dead one (wizard `mode`, dropped on persist).

## 2. Strengths

1. **The kernel is real and doc-faithful.** Oracle/Reasoner/Guardrails/Runtime/Writer exist, are pure where designed, mode-blind where promised (`guardrails.ts:13-15`), contracts-as-data with runtime-verified invariants, full loop persistence with replayable fact snapshots. It was live-verified end-to-end on real Calendar (pilot).
2. **The explainability CORPUS is exceptional.** Per-turn `ai.bot_turn` (toolCalls, activeGoal, behaviorState), per-iteration `reasoningSummary` + `oracleFactsSnapshot`, replayable shadow evals, policy-attributed approvals. The platform already "thinks out loud" — to the database.
3. **The approval surface is genuinely trustworthy** — what/why/risk/params/policy/decide, idempotent, socket-live. The one place the product explains itself, and it's good.
4. **Cost discipline at the choke point**: single generateResponse gateway, cache-aware block-layered prompt, sorted tool arrays, per-row cache telemetry, billing metering wired (dormant).
5. **Safety-by-default at the edge**: per-conversation turn cancellation (no double replies), deterministic escalation ceilings, honest PENDING_APPROVAL customer contract, budget preflights, fail-soft everywhere in context assembly.
6. **Creation wizard is 70% right**: conversational, live preview, draft/resume, generated salesContext (the model moment), readiness report — the "hire an employee" feeling exists in flashes.
7. **Kernel discipline holds**: no role mechanism, mode, or capability bypasses Runtime/Guardrails/tool-gate anywhere we could find.

## 3. Weaknesses

1. **Two brains, one duplicated everything** — escalation gates, handoff regexes, identity heuristics, goal logic, capability grouping, three executors, three action vocabularies with hand-kept bridges. Every legacy feature deepens migration debt.
2. **The legacy brain is a compensation stack**: 4 mini-loops + 5 regens + 23 QUALITY_CONTRACT rules + 2 in-loop gates ≈ 8k+ deletable lines and up to ~21 LLM calls/turn — each a named production scar, none yet converted to the evals that the deletion gate requires.
3. **The kernel reasons with stubbed signals**: RBAC allow-list `[]`, billing.status hardcoded "active", goal:null — Guardrails rules 1-2 are unreachable code.
4. **Observations drop `result.data`** — the kernel can run RAG/CRM/custom reads but cannot read what they returned. KNOWLEDGE/CUSTOM are structurally blind.
5. **The owner sees almost nothing** (1 YES of 14 owner questions). Bot messages indistinguishable from human; escalations reason-less; analytics page fabricated; per-employee metrics absent.
6. **Failure = customer silence** in every hard path (AI timeout, budget, billing block, outgoing retries exhausted).
7. **Roles are compiled** — 0 of 8 example roles expressible as data; a new role costs 7-8 synchronized edits incl. frontend; language (he/en) is hardwired into role mechanics.
8. **Creation ends in a broken promise** — "Save & go live" wires no routing; the new employee may never receive a conversation, and nothing says so.

## 4. Critical Blockers (fix before anything else matters)

| # | Blocker | Evidence |
|---|---|---|
| B1 | **New employees can be unreachable after creation** — no routing wired at /complete; no canvas node → conversation unassigned forever, silently | part1 §1.6, backend#1 |
| B2 | **AIAgent.status never enforced at runtime** — PAUSED/DRAFT agents keep answering customers; "Pause" is cosmetic | part1 backend#2 |
| B3 | **Customer silence on failure** — AI timeout/error, budget exhaustion, billing block, outgoing retry exhaustion all end in silence | part6 finding#1 |
| B4 | **Fabricated analytics page** — the "AI performance" screen is hardcoded demo data; the mandated metrics (approval/override rate) are computed nowhere | part6 §6a |
| B5 | **Human takeover is one-way and race-prone** — no hand-back-to-AI exists; approve-after-takeover silently re-activates the bot; takeover mid-loop undetected (kernel can write after a human owns the conversation) | part3 G1/G2 + §5 |
| B6 | **Kernel approvals resume through the legacy executor** — PRE/POST invariants skipped exactly on the highest-risk (HITL) writes; param-shape mismatch will break CRM graduation | part3 G3, part2 finding#3 |
| B7 | **costUsd is wrong for the default model** (~3.3× understated output) — every financial number downstream is corrupt | part6 finding#3 |
| B8 | **Server-side activation has no validation** — any API client creates a nameless, KB-less ACTIVE employee; the knowledge gate is client-side theater | part1 backend#3 |

## 5. UX Audit (summary — full: part1 §2-3, part4)

- Wizard: right species, wrong ending. Field-by-field verdicts in part1 §2 — stop interviewing for: success criteria, tone/style, languages, funnel design, name, per-tool checkboxes. Keep: the one job-description question, custom guardrails (once), knowledge (gated on processed content).
- Missing hiring concepts: **the desk** (routing/channels), **probation** (per-employee shadow/supervised start), **the profile** (mission + activity + health, not 9 config sections).
- Inbox: no AI badge, no per-message why, reason-less escalation dividers. Approvals: the gem — enrich (riskTags, goal context, if-rejected, track record). Analytics: delete the fake page.
- The 14-question owner scorecard: 1 YES / 7 PARTIAL / 6 NO (part4 §2).

## 6. Backend Audit (summary — full: part1 §4, part6)

Creation: no server-side readiness enforcement on ANY promotion path; status unenforced at dispatch; AgentToolPermission unique-key defect (duplicate grants accumulate); tenant-global draft resume race; dead endpoint `/ai-agents/generate` (live LLM spend); 8 dead schema fields; wizard LLM given tools its prompt forbids.
Pipeline: webhook 200-before-verify + optional verification; no DLQ; outgoing worker unlimited; bot replies bypass the queue; provider boundary has no retry/timeout config; per-turn cost/latency attribution impossible (no turnId on usage rows, no duration captured).

## 7. Reasoning Audit (summary — full: part2)

The decided 6+2 architecture is ~70% built and clean. Between here and one-brain: (a) three stubbed Oracle signals, (b) observation data projection, (c) approval-resume through the Runtime, (d) heuristic→eval conversion (0 of ~30 named incidents are evals yet), (e) then the ordered 8k-line delete. Loop hygiene pre-autonomy: no-progress bound (doc says yes, code says no — decide), anti-stall burns 40% of budget, ~40 world reads/turn unmemoized, regex-parsed approval refs with wrong-id fallback, non-idempotent turnId. Prompt economics: legacy ~10-18k tokens/turn vs kernel ~2-4k; the biggest lever is deleting the ~9 compensation LLM passes, not optimizing them.

## 8. Modes Audit (summary — full: part3)

"Reasoning identical, execution differs": **engineered true per-iteration in the kernel; structurally incomplete across iterations** (shadow trajectories diverge after the first dry-run write and **contaminate shared AgentCustomerMemory** that autonomous will consume); **false for the live copilot** (BEL forces SUPPORT_AGENT strategy + reduced surface); **contradicted by design** in the dormant worker (mode-as-prompt). Shadow cannot prove write arcs or approvals (advisory short-circuits before the gate) — calendar was actually promoted on pilot scripts. OPERATION_STATUS ledger is telemetry, not enforcement. All mode levers are env-only with zero UI.

## 9. AI Employee Experience Audit (summary — full: part4)

Verdict: an explainability **delivery** gap, not a generation gap. Everything needed for trust is already persisted; missing are one read API (audit/loop), three small persistence writes (plan-why, escalation case, readiness), two un-droppings (riskTags, copilot rationale), one fake page to delete. Proposed IA: Employee Profile (Overview/Activity/Knowledge/Permissions/Performance/Configure), decision timeline, inbox AI attribution, waiting-state chips, feedback loop where every 👎 becomes a shadow-eval case — owner trust and migration evidence become the same pipeline.

## 10. Role Skills Audit (summary — full: part5)

Three parallel role systems (legacy compiled Skill consts + worker duplicate + loop binding). The loop binding is already ~90% of the pure-data target. Skill structs are data-shaped but compiled; new role = 7-8 code edits across 2 packages + frontend (`FUNNEL_ROLES` triplicated). Language is the hidden coupling (he/en regexes gate promotion/regen/knowledge-matching — third languages silently lose their profession). Two roles are internally broken as shipped (RECEPTIONIST promises routing with no routing operation; CUSTOMER_SUCCESS collapses to booking). Kernel discipline intact. Target: `RoleDefinition` registry seeded via the proven industry-pack pattern (schema proposed in part5 §3).

## 11. End-to-End Audit (summary — full: part6)

Typical turn: 3-5 blocking LLM calls, ~4-9s happy path; worst case ~21 calls, 30s+; shadow tenants +8 calls/turn. Caching discipline real but memoryBlock churn halves it. Budgets exist (fail-open, preflight-only, regens exempt). Recovery strong inside the turn, weak at provider/queue boundaries. Observability write-rich/read-poor. Analytics: mandated metrics absent, fake frontend. Evaluation: replayable corpora, capture-only, no feedback loop, manual harnesses not in CI.

---

## 12. Prioritized Roadmap

### P0 — Trust & correctness (the platform tells the truth and fails loudly)
1. Enforce `AIAgent.status` at dispatch (worker + ai service) — PAUSED means paused. [B2]
2. Server-side `draftReadiness` gate on `/complete`, PATCH-promote, and POST create. [B8]
3. Kill customer silence: fallback message on AI failure/timeout, budget/billing block, and outgoing exhaustion (single "we'll get a human" path + escalation). [B3]
4. Fix `AI_MODEL_PRICING` (add gpt-5 family + correct cached discount). [B7]
5. Hand-back-to-AI transition (API + UI) + approve-after-takeover respects ownership + ownership check between loop iterations. [B5]
6. Replace the fake analytics AI block with 4 real numbers (AI-handled share, escalation rate, approval approve/reject rate, tool success) + compute approval/override rates. [B4]
7. Persist + surface escalation reason (bot_turn metadata + Message.metadata + inbox divider). [Q8 NO→YES]
8. Go-live honesty: on /complete, detect unreachable employee (no canvas node) → offer default routing or show "not receiving conversations yet". [B1]
9. Quick trust wins bundle: render riskTags; un-drop copilot rationale; AI badge on bot messages.

### P1 — Kernel completion + observability delivery (weeks)
1. Thread real RBAC allow-list, billing.status, and committed goal into the Oracle. [part2 #1]
2. Observation `data` projection (bounded) so KNOWLEDGE/CUSTOM/CRM reads are consumable. [part2 #2]
3. Approval-resume through the Capability Runtime (dispatch by operation + stored ExecutionRequest). [B6]
4. Mode hygiene: gate AgentMemory persistence on mode; split `advisory` vs `dry_run` (+simulated approval gate in dry_run); enforce OPERATION_STATUS in guardrails; kernel escalation ceiling parity.
5. Audit/loop read API + Decision Timeline (Activity tab + conversation rail) + persist plan-why + readiness persistence/re-run.
6. Per-turn attribution: turnId + durationMs on usage rows; per-employee usage rollup; cache-hit + regen-rate aggregation.
7. Model tiering/caching for knowledge_resolve + wizard_binding micro-calls; provider retry/backoff/timeout at generateResponse.
8. Effective-permissions endpoint + per-employee permissions view (reuses runtime AND-rule).
9. Delete the dormant `services/ai/src/worker/*` stack (salvage prompt-hash drift check into live paths); delete `/ai-agents/generate`; dead-schema-fields migration; loop hygiene fixes (turnId idempotency, approval-ref threading, optional no-progress bound decision).
10. Wizard: the Desk step (routing binding) + per-employee probation (shadow mode as DB field per agent, not env) + KB gate on processed content.

### P2 — Strategic (the 5-10 year kernel)
1. RoleDefinition registry (roles-as-data, industry-pack machinery), collapse worker skills + QUALITY_CONTRACT split; language-neutral objective/gate mechanics (extractor-facts pattern).
2. Heuristic→eval conversion program: every compensation layer becomes a named eval; shadow-pass; then the ordered ~8k-line legacy deletion (three-executors first).
3. Owner feedback loop (BotTurnFeedback → suggested config change → eval corpus intake) + weekly digest.
4. Employee Profile UX (Overview/Knowledge/Performance tabs) + waiting-state chips platform-wide.
5. Generic integration webhooks + sync (already designed in integration-framework.md) once connector work resumes.

## 13. Quick Wins (hours each)
riskTags render · copilot rationale passthrough · escalation-reason divider · AI badge on bot messages · pricing-table fix · delete `/ai-agents/generate` · thin admin page over `/api/reasoner-shadow` · persist readiness JSON on AIAgent · alert on prompt-hash drift + surfaced-tool-DENIED invariant violations · `docker compose logs` decision-trace → persisted.

## 14. Delete
`services/ai/src/worker/*` (~2.3k lines dormant second architecture) · `POST /api/ai-agents/generate` + frontend `generateAIEmployeeConfig` · dead schema fields (`escalationGates`, `capabilities{auto,assist}`, `tone`, `style`, `toneConfig`, `interactiveMessages`, legacy `goals`) · analytics `DEMO_*` constants · dead Redis rollups (tool_executed/ai_message_sent/conversation_analyzed) · `incoming-worker/knowledge-retrieval.service.ts` (orphaned RAG copy) · **scheduled** (evidence-gated, P2): the ~8k-line legacy compensation plane per part2 §4.

## 15. Simplify
One readiness concept (server-enforced draftReadiness; LLM report advisory) · 4 wizard steps → 2 + profile card · one escalation-gate home (edge XOR ai-service, not both) · one executor (Capability Runtime) · one Oracle in the target brain (shadow reuses live assembler) · collapse copilot onto kernel advisory mode · builder LLM tool surface = what its prompt allows.

## 16. Become Data
Skill structs, ROLE_TO_SKILL, OBJECTIVE_CHAINS, brand archetypes, playbooks, FUNNEL_ROLES/PRODUCT_CONTEXT_SKILLS/ROLE_GOAL_FALLBACK/ROLE_HUMAN_NAMES → RoleDefinition rows · QUALITY_CONTRACT sales rules → SALES pack · locale packs auto-discovered · OPERATION_STATUS ledger → DB (and enforced) · mode per employee → AIAgent column · escalation ceilings → policy config.

## 17. Become Operations
KB retrieval pre-step → `SEARCH_KNOWLEDGE` (exists; blocked on observation data) · reschedule/cancel/booking flows (done — CALENDAR contracts) · CRM writes → `UPSERT_CUSTOMER`-family (exists in shadow) · routing/department-handoff → a ROUTE_CONVERSATION operation (unblocks RECEPTIONIST) · retention/expansion outcomes for CUSTOMER_SUCCESS.

## 18. Become Observations
Tool/read results (`result.data` projection) · approval outcomes (approve/reject/expiry re-enters the loop) · pending-approval state in Facts · integration health changes · knowledge-gap events (empty/low retrieval) · takeover events (human joined mid-loop).

## 19. Become Policies
Hard escalation ceiling (msg/burst caps) as loop-policy fields · human-request keyword override (documented as mode-agnostic edge policy) · guaranteed background CRM writes → post-tick reconciliation invariant · OPERATION_STATUS enforcement · quiet hours/blocked topics (already policy — keep).

## 20. Become Runtime Responsibilities
Idempotency/dedup/circuit-breaking (side-effect-classifier + orchestrator logic → resolver envelope) · approval resume execution · POST-invariant verification on resumed writes · booking-grounding (POST invariants already make fabrication impossible — reply-side check folds into output-validator) · per-loop world-read memoization with owner-write invalidation.

## 21. Remain Deterministic Forever
Guardrails (authorize) · budget/billing enforcement · tool-gate/HITL policy evaluation · PRE/POST invariants + success verification · loop resource bounds · output-validator (slim, security) · prompt-sanitizer · turn cancellation · audit/persistence writes · the Oracle's composition (pure assembly, no LLM).

## 22. Final Scores (0-10)

| Subsystem | Score | One-line justification |
|---|---|---|
| Cognitive kernel (target brain) | **8.0** | Doc-faithful, pure, live-verified; three stubbed signals + blind observations keep it from 9+ |
| Explainability corpus (write side) | **8.0** | Replayable, structured, complete — best-in-class for a platform this age |
| HITL / approvals | **7.0** | Best surface + idempotent gate; legacy-executor resume hole + no shadow coverage |
| Billing/metering plumbing | **7.0** | Wired at the choke point, data-driven pricing; dormant by default, pricing table wrong |
| E2E message pipeline | **6.0** | Solid queues/idempotency/cancellation; silence-on-failure, no DLQ, verify-optional webhooks |
| Creation wizard (UX) | **6.0** | Conversational + preview + readiness are right; broken go-live promise, paper gates |
| Cost/prompt-cache discipline | **6.0** | Real engineering (blocks, sorting, telemetry); regen ladder + micro-calls + churn defeat it |
| Evaluation/shadow infrastructure | **6.0** | Replayable corpora + ladder doctrine; capture-only, can't prove writes, not in CI |
| Legacy brain (production quality) | **5.0** | It ships and is instrumented — at ~21-call worst case and 8k lines of scar tissue |
| Execution modes | **5.0** | Kernel claim engineered true; 5 vocabularies, copilot forks reasoning, env-only control |
| Role skills | **5.0** | Data-shaped but compiled; 0/8 data-only; he/en hardwiring; 2 roles internally broken |
| Creation backend | **4.0** | No server-side validation, unenforced status, key defect, dead fields/endpoint |
| Owner experience (read side) | **3.0** | 1 of 14 owner questions answerable; AI invisible in inbox |
| Analytics | **2.0** | Mandated metrics absent; flagship page is fabricated demo data |
| **Platform overall** | **5.5** | A genuinely excellent kernel and corpus wrapped in a product that doesn't show it and a legacy plane that doubles everything |

---

### The one-paragraph verdict

GOTCHA has already built the hard part: a mode-blind reasoning kernel with contracts-as-data, deterministic guardrails, replayable evidence, and honest approval flows — the 5-10-year foundation the mission asks for. What it has not done is *finish* anything around that kernel: three stubbed inputs keep its guardrails decorative, its observations discard what its operations read, its approvals resume through the brain it is meant to replace, its owner-facing product renders almost none of the evidence it so carefully persists — and one page fabricates it. The path is not redesign; it is completion, deletion, and delivery: complete the kernel's inputs/outputs, delete the second and third architectures (one dormant, one legacy-and-evidence-gated), and deliver the already-persisted "why" to the people who pay for it.
