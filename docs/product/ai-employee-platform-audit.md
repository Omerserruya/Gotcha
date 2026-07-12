# AI Employee Platform Audit — The Hiring Experience & the Employee's Self

> **Type:** Founder-level platform due-diligence audit (Principal Product Architect + Principal AI Architect + Principal UX lens).
> **Date:** 2026-07-08 · **Branch:** `feat/customer-intelligence-phase1` (working tree).
> **Method:** Phase-separated (Audit → Vision → Roadmap → Playbook). Every current-state claim is `file:line`-cited from a direct 2026-07-08 code trace. The frozen architecture (cognitive kernel, capability runtime, connector model, observation/operation model) is assumed correct and is **not** redesigned.
> **Relationship to prior docs — read this first.** Four companion docs already exist and are canon:
> - `docs/architecture/ai-employee-platform-audit.md` (2026-07-05) — the **engineering** audit (kernel, brains, modes, blockers B1–B8). This document is the **product** audit that sits above it and, critically, **re-verifies its blockers against the newer working tree** (several are now fixed).
> - `docs/product/ai-employee-hiring-experience-spec.md` — the aspirational UX spec (9 hiring moments + the post-hire relationship). Canon; not rewritten.
> - `docs/product/ai-employee-experience-vision.md` — the six-act owner journey.
> - `docs/product/ai-employee-hiring-experience-status.md` (2026-07-05) — the built-vs-spec reconciliation. This audit updates it.
> **Constraint honored:** audit only — no code modified.

---

## Executive Summary

GOTCHA has built the most expensive part of an AI-employee platform — a reasoning kernel that decides before it acts, gates risk deterministically, and records a replayable "why" for every turn — and since the 2026-07-05 audit it has closed the correctness embarrassments (the B-blockers). What it has **not** built is the thing the whole product is named for: **the experience and the persistent self of a hired employee.** The kernel is a mind; the product still ships it as a settings row.

**The re-verification headline (news since 2026-07-05):** the eight critical blockers are largely fixed in the working tree — B2 (status enforced at dispatch: `incoming-worker/ai-bot.service.ts:99-101`), B3 (no customer silence on AI failure: `:611-666`), B4 (real analytics, "no demo data": `analytics/page.tsx:24`), B7 (gpt-5 pricing: `ai-usage.ts:17-47`), B8 (server-side activation gate on all three public paths: `ai-agent-builder.ts:350-358`), and B1 mitigated by a truth-telling reachability endpoint (`ai-agents.ts:695-724`). **This moves the platform from "lying" to "honest."** It does not move it to "feels like hiring."

**The one-sentence verdict:**

> **The employee is still, in the data model, a configuration row with a three-state switch (`AIAgentStatus = ACTIVE|DRAFT|PAUSED`) — it has no career, no authority it earns, no memory of being coached, and no performance record it is reviewed on. Every gap that matters is the same gap: the employee has no self, so the owner manages software, not a colleague.**

Three facts anchor this:

1. **Everything needed for trust is persisted, and almost none of it is delivered.** The platform computes a six-dimension `AgentScore` after every conversation (`agent-performance.service.ts:5-171`) — and **no tenant UI ever reads it** (`getAgentScores` is defined in `api.ts:1653` and called nowhere). It records a full decision timeline — surfaced **ADMIN-only**, one conversation at a time (`decision-timeline.ts:40`). It computes BEL trust/friction signals every turn — persisted only to an audit row, visible to no one by design (`behavior-engine.service.ts:84-95`). The corpus is exceptional; the delivery is near-zero.
2. **Probation — the single largest adoption lever — is an env flag, not a product.** The Shadow→Assist→Autonomous machinery exists and works, but the mode is chosen by `AGENT_LOOP_MODE` + an `AGENT_LOOP_TENANTS`/`AGENT_LOOP_AGENTS` allow-list (`flags.ts:34-36`, `operation-status.ts:71-75`), the default brain is still the legacy Planner, and **`AIAgent` has no autonomy/mode/shadow column at all.** The owner cannot watch an employee earn trust because there is no owner-facing ladder.
3. **The two hiring surfaces disagree, and neither is a hire.** The AI-Studio wizard is a competent conversational configurator (`AgentBuilder.tsx:111`) that still interviews the owner and ends in "Save live"/"Skip to editor" — the spec's Moments 0/1/3/7 (opener, candidate arrival, self-written JD, offer letter) remain unbuilt. Meanwhile the **new onboarding flow** introduced a genuine hire verb ("Meet who I'd hire first"; `hireRecommendedEmployee()` at `onboarding.ts:78`) — but it creates a **KB-less ACTIVE agent via an internal path that bypasses the very readiness gate the wizard enforces** (`agent-config-generator.ts:240,254`). The product now has two employee-creation doors with different rules and different vocabularies.

**Overall platform score (product lens): 5.5/10** — an 8/10 kernel and an 8/10 evidence corpus wrapped in a 3/10 owner experience. The distance to category-defining is not more intelligence; it is **giving the employee a self and delivering the evidence that already exists.**

---

# PHASE 1 — CURRENT STATE AUDIT

## 1.1 Evidence base

Direct trace (2026-07-08 working tree): `frontend/src/app/ai-studio/agents/[id]/{page.tsx,AgentBuilder.tsx}`, `ai-studio/page.tsx`, `approvals/page.tsx`, `analytics/page.tsx`; `services/ai/src/routes/{ai-agent-builder,ai-agents,decision-timeline,agent-scores}.ts`; `services/ai/src/services/{agent-builder,agent-readiness,agent-performance,behavior-engine,agent-config-generator,planner}.service.ts`, `agent-loop/{flags,operation-status,bot-loop-adapter}.ts`, `reasoner/`; `services/conversation/src/routes/approvals.ts`; `services/incoming-worker/src/services/ai-bot.service.ts`; `packages/shared/prisma/schema.prisma`. Cross-checked against the four companion docs.

## 1.2 The lifecycle as implemented (stage → what exists → maturity)

| Stage | What exists | Where | Maturity |
|---|---|---|---|
| **Need → Hire** | Two doors. (A) AI-Studio wizard: conversational 4-step builder `chat→kb→refine→tools` + live draft + SSE tool loop + brand-voice archetypes (`AgentBuilder.tsx:111,435-474`; `ai-agent-builder.ts:56-523`). (B) Onboarding: MeetScreen + `hireRecommendedEmployee` (`onboarding.ts:78-119`). | services/ai + services/auth | Built, E2E; **config-shaped, not hire-shaped**; spec Moments 0/1/3/7 absent |
| **Draft / Resume** | `DRAFT` + `builderStep` pointer; `/start` resumes most-recent incomplete draft; `/step` persists each transition; `/complete` flips ACTIVE; "Continue setup" strip + Discard | `ai-agent-builder.ts:71-95,312-332,373-380`; `ai-studio/page.tsx:99-171` | Built; resume is **tenant-global, not per-user** (any admin resumes any admin's draft) |
| **Training / Knowledge** | Mandatory ≥1 KB (client+server); in-wizard KB upload modal; auto-KB seeding from taught onboarding gaps | `AgentBuilder.tsx:552-558`; `agent-builder.service.ts:186-199`; `onboarding.ts:2109-2116` | Built as a **one-time gate**, not continuous "teach me" |
| **Readiness** | Real LLM: 28–36 generated customer Qs, per-Q coverage `full/partial/none`, typed gaps; **deterministic** score `100*(full+0.5*partial)/total`; persisted to `readinessReport`; re-runnable | `agent-readiness.service.ts:129-242`; `ai-agent-builder.ts:436-445` | Built; **advisory only — gates nothing** ("Skip to editor" bypasses; `/complete` never reads it) |
| **Activation gate** | `draftReadiness` = name + role + goal-or-funnel + ≥1 KB, enforced on `/complete` (422), PATCH-promote, POST-ACTIVE | `agent-builder.service.ts:186-199`; `ai-agent-builder.ts:350-358`; `ai-agents.ts` create/patch | Built server-side (**B8 fixed**) — **except** the onboarding internal generator, which creates KB-less ACTIVE agents (`agent-config-generator.ts:240`) |
| **Go-live routing** | Reachability truth endpoint + editor warning banner; routing is the FlowCanvas graph | `ai-agents.ts:695-724`; `agents/[id]/page.tsx:731-746` | **B1 mitigated, not solved** — `/complete` still wires no routing; onboarding compensates with a RouterRule (`agent-config-generator.ts:265-279`) |
| **Operation (runtime brain)** | Legacy Planner is the DEFAULT customer brain; kernel drives only when `AGENT_LOOP_MODE=autonomous` AND agent allow-listed; reasoner is shadow-only | `ai-bot.service.ts:844-880`; `flags.ts:34`; `shadow-runner.ts:6-13` | Kernel real but dormant for customers; two brains coexist |
| **Probation / autonomy** | Shadow/Assist/Autonomous machinery exists but is **env-level**; `AIAgent` has no mode column; a separate per-turn `full/gated/advisory` autonomy is prompt-only | `flags.ts:34`; `operation-status.ts:71-75`; `behavior-engine.service.ts:806` | **Not a product** — invisible, not per-employee, not owner-controlled |
| **Oversight / HITL** | Approvals queue (tabs, live socket, reject-requires-reason); kernel approvals resume through the Capability Runtime; approver≠requester; status-aware un-pause | `approvals/page.tsx:22-123`; `approvals.ts:57-195` (kernel path `:80-96`) | **The gem** — best-explained surface; B5/B6 substantially addressed |
| **Explainability** | Decision Timeline (reasoning/decision/operation/observation) | `decision-timeline.ts:40-89`; `DecisionTimelinePanel` gated `role==="ADMIN"` (`ChatPanel.tsx:551-568`) | Built but **ADMIN-only, per-conversation** — not owner-altitude, not proactive |
| **Performance** | 6-dimension `AgentScore` computed + stored per conversation | `agent-performance.service.ts:5-171`; `/api/agent-scores` (ADMIN) | **Computed, never surfaced** — zero frontend consumer |
| **Learning / coaching** | None for employees. Adjacent: `AgentCustomerMemory` (kernel continuity), copilot cue trust-weights, one-shot pre-deploy TuneScreen | `schema.prisma:2551-2564`; `copilot-outcomes.ts:1-40`; `onboarding.ts:96-108` | **Not built** — post-deploy improvement is manual re-config |
| **Management at scale** | Flat agent list; RouterRule/Main Playbook routing; no AI-manager, no shared memory/delegation | `ai-studio/page.tsx`; `MainPlaybookEditor.tsx` | Not built (per Product Bible §7) |
| **Retirement** | Delete only; no inheritance | `deleteAIAgent` | Not built |

## 1.3 The employee object (`AIAgent`, `schema.prisma:426-531`)

**Exists (the "tool" facets):** identity (`name, role, avatarColor, persona{gender,traits,customAttributes}+brand_archetype`), LLM config (`systemPrompt, model, temperature, maxTokens`), structured blocks (`identity, goals[legacy], toneConfig, behavioral`), `salesContext`, `readinessReport`, first-class `goal/successCriteria`, autonomy knobs (`maxAutonomousMessages/Minutes, confidenceThreshold`), `escalationGates` (deterministic), `capabilities{auto,assist}`, KB M2M, `departmentId`, `funnelId`.

**Does NOT exist (the "employee" facets — grep-verified against the full schema):** no `RoleDefinition` table (roles are compiled strings); **no `tunedPersona` column** (onboarding tuning is flattened into `tone` + a `# Owner tuning` text append to `systemPrompt`, `onboarding.ts:96-108`); no coaching/correction store; no performance rollup on the employee (only per-conversation `AgentScore` rows); no authority-envelope object (authority is a per-tool boolean `AgentToolPermission.requireApproval` + free-text `customGuardrails`); no probation/trust-ladder state; no `ShiftReport`; no `jobDescription` artifact; no per-agent autonomy-mode column.

**Live defect (unfixed since 2026-07-05):** `AgentToolPermission`'s unique key is `@@unique([tenantToolId, departmentId, agentId])` — `aiAgentId` is not part of it and is NULL for agent-level grants (`schema.prisma:1376`), so the DB does not prevent duplicate grants; builder code compensates with findFirst-then-update and `createMany skipDuplicates` (`ai-agent-builder.ts:170-172,201-204`), which don't close the race.

## 1.4 What works well (do not redesign)

1. **The kernel and its evidence corpus.** Oracle→Reasoner→Guardrails→Runtime→Writer, replayable runs, per-iteration reasoning snapshots. Frozen, correct, best-in-class for the platform's age. (Confirmed still intact; `ai-bot.service.ts:844-880`, reasoner shadow.)
2. **The approvals surface.** What/why/risk/params/policy/decide, live socket, reject-requires-reason, approver≠requester, and — new since the last audit — kernel approvals resume through the Capability Runtime (`approvals.ts:80-96` → `agent-loop-resume.ts`) rather than the legacy executor. This is the tonal template for the whole product. Keep and extend.
3. **The readiness test.** Genuine LLM question-generation + deterministic scoring + typed gaps is a real "I studied for the job" artifact. Keep the engine; change only that it currently gates nothing.
4. **Server-side activation validation (B8).** Name/role/goal-or-funnel/≥1 KB enforced on every public promotion path. Keep; close the onboarding-internal exception.
5. **Reachability honesty (B1).** Telling the UI the truth ("this employee receives no conversations") instead of a broken "go live" promise. Keep; evolve toward auto-wiring.
6. **Kernel discipline holds.** No mode, role, or capability bypasses Runtime/Guardrails/tool-gate; the tool-surface AND-rule (allowed ∧ enabled ∧ CONNECTED) is enforced everywhere (`tool-gate.ts:261-267`; `agent-tools.ts:861-868`). Keep as an invariant.

## 1.5 Weaknesses

### Product debt (the category-defining gaps)

- **PD-1 · The employee has no self.** No authority envelope, no performance record on the employee, no coaching store, no lifecycle beyond DRAFT/ACTIVE/PAUSED. This is the Product Bible's central thesis and it is unchanged. Every item below is a symptom.
- **PD-2 · Probation is an ops toggle, not a product** (`flags.ts:34`; no `AIAgent` mode column). The #1 adoption barrier ("I'd never let AI touch my customers") has no owner-facing answer.
- **PD-3 · Trust evidence is persisted but undelivered.** `AgentScore` has no UI (`api.ts:1653` uncalled); Decision Timeline is ADMIN-only and per-conversation (`decision-timeline.ts:40`); BEL signals are audit-only by design (`behavior-engine.service.ts:84-95`); there is no shift report. The owner sees ~1 of the 14 things that would build trust.
- **PD-4 · Two hiring doors, divergent rules and vocabulary.** Wizard (interviews owner, "Save live", KB-gated) vs onboarding (`hireRecommendedEmployee`, hire verb, **KB-less ACTIVE bypass** at `agent-config-generator.ts:240`). The hire metaphor exists in exactly one place and the two doors don't agree on what "ready" means.
- **PD-5 · No post-deploy learning loop.** Corrections/👎 vanish; improvement is manual editor re-config. The flywheel the Product Bible calls "the moat" (correction = training + eval) does not exist (no `BotTurnFeedback` model; grep empty).
- **PD-6 · Roles are compiled.** No `RoleDefinition`; a new role is still a multi-file code change; the "hire an SDR / Receptionist / Billing Specialist" library is thinner than the pitch.

### UX debt

- **UD-1 · The post-hire home is a settings page.** The agent editor is nine SectionCards (`agents/[id]/page.tsx:791-1530`), not a living profile with Overview/Today/Knowledge/Access/Performance.
- **UD-2 · The "hire" ceremony shatters at go-live** (documented in the status doc; still true): meeting/tuning happen in onboarding, then the employee becomes a config panel; "Save live"/"Skip to editor" is a dropdown-grade climax.
- **UD-3 · Readiness looks like proof but gates nothing** — skippable, self-coverage-graded, never read by activation.
- **UD-4 · Reachability is surfaced only in the editor** — a user who never opens the editor never learns their ACTIVE employee receives nothing.
- **UD-5 · Explainability altitude is wrong** — a raw ADMIN-only decision timeline, not the colleague-altitude headline→reasoning→trace the vision demands.

### Technical debt

- **TD-1 · `AgentToolPermission` unique-key defect** (`schema.prisma:1376`) — duplicate grants representable; compensated in code, not the DB.
- **TD-2 · Dead `/api/ai-agents/generate`** still exists and still makes a live LLM call (`ai-agents.ts:95,~181`) with zero frontend callers — the audit's "delete" item is not done.
- **TD-3 · Third creation path bypasses the KB-mandatory rule** (`generateAllAgentConfigs` → `agent-config-generator.ts:240` writes ACTIVE via Prisma directly).
- **TD-4 · "Dead" fields are being re-animated.** `tone/toneConfig/style/interactiveMessages/goals[legacy]` were slated dead, but onboarding deploy now WRITES `tone` (`onboarding.ts:99`) while prompt-builder says tone is centrally governed (`prompt-builder.service.ts:72`) — a field is dead and written at once.
- **TD-5 · Builder LLM is handed tools its prompt forbids** (`agent-builder.service.ts:375-388` vs `:256-257`) — unfixed "simplify" item.
- **TD-6 · Tenant-global draft resume race** (`ai-agent-builder.ts:71-95`) — any admin resumes any admin's draft.
- **TD-7 · Stray artifact** in the tree: zero-byte `services/ai/src/routes/ai-assist.ts.tmp.2029385...`.

## 1.6 Scores (0–10, product lens; engineering-lens scores in the 2026-07-05 audit remain valid for the kernel)

| Subsystem | Score | One-line justification |
|---|---|---|
| Cognitive kernel (target brain) | **8.0** | Doc-faithful, pure, live-verified; still dormant for customers |
| Approvals / HITL | **7.5** | Best surface; kernel-resume path now closes B6's worst case |
| Explainability corpus (write side) | **8.0** | Replayable, structured, complete |
| Explainability **delivery** (read side) | **3.0** | ADMIN-only, per-conversation, no shift report, no owner altitude |
| Creation wizard (as configurator) | **6.5** | Conversational, draft/resume, readiness — good; not a hire |
| Creation as **hiring experience** | **3.0** | Moments 0/1/3/7 absent; two divergent doors |
| Readiness test | **6.0** | Real engine; gates nothing |
| Activation backend (B8) | **7.0** | Enforced on public paths; onboarding-internal bypass |
| Employee object (the "self") | **3.0** | Tool facets ✅, employee facets ❌; lifecycle = 3 states |
| Probation / earned autonomy (owner-facing) | **2.0** | Env flag, no per-employee state, invisible |
| Performance surface | **2.0** | Computed every conversation, rendered nowhere |
| Learning / coaching loop | **1.5** | Does not exist for employees |
| Roles as data | **3.0** | Compiled; no `RoleDefinition` |
| **Platform overall (product)** | **5.5** | Excellent mind, no self, undelivered evidence |

**Category-defining today:** the kernel; the approvals surface; the readiness engine; the reachability-honesty pattern.
**Ordinary today:** the creation wizard as a configurator, the settings-page profile, the ADMIN-only timeline — and everything about the employee *after* it goes live.

---

# PHASE 2 — VISION

*Kernel frozen. First principles. The spec and vision docs describe the felt experience correctly; this phase specifies the SYSTEM changes that make the felt experience representable and durable.*

## 2.1 The one structural move: give the employee a self

Every P0/P1 gap collapses into one schema-and-surface change: **the employee becomes a persistent entity with a career, an authority envelope, a performance record, and a coaching memory** — the ❌ column of the Product Bible §4. Concretely, four first-class objects the kernel already produces evidence for:

1. **A lifecycle state** replacing the ACTIVE/PAUSED/DRAFT bit: `HIRED → PROBATION(Shadow→Assist→Autonomous) → EMPLOYED → PAUSED/RETIRED`, **per-employee, owner-controlled, reversible.** Move mode off `AGENT_LOOP_MODE` env and onto an `AIAgent` column the owner graduates.
2. **An authority envelope** (money / irreversibility / external-reach limits + track record) replacing the per-tool boolean — the object promotions are granted against.
3. **A performance record** — the already-computed `AgentScore` rolled up onto the employee, plus the override-rate-declining trend (the single most trust-building number).
4. **A coaching store** — every override/edit/👎 captured as remembered coaching AND a platform eval (owner trust and engineering progress become one pipeline).

**Why:** the kernel is a mind with no biography. A mind you can't watch grow is software; a self you supervise into trust is a colleague. This is the entire moat and it is buildable on the frozen architecture.

## 2.2 Deliver the evidence that already exists

Nothing new needs to be computed for trust — it needs a home:

- **The Shift Report** (proactive, plain-language, daily) composed from `AgentLoopRun` + approvals + `AgentScore`. The corpus exists; the narrative does not.
- **The living Employee Profile** (Overview / Today / Knowledge / Access & Authority / Performance + a quiet Manage drawer) replacing the nine SectionCards.
- **The decision timeline at colleague altitude** (headline → reasoning → full trace, owner-chosen depth) and **not** ADMIN-gated — the owner IS the manager.
- **`AgentScore` surfaced** — turn the dead `getAgentScores` into the Performance tab.

## 2.3 One hiring door, and it is a hire

Collapse the two creation paths into the spec's flow: **job posting → candidate (self-written JD, proposed tools, questions it has) → offer.** The onboarding MeetScreen/TuneScreen is already 60% of Moment 1–2; the wizard already has the primitives (draft, readiness, tool grants). Unify them so both onboarding and AI-Studio enter the same candidate experience, and make the KB rule identical on both doors (close the onboarding bypass).

## 2.4 The tuned persona becomes structured genome, not a text append

The onboarding tune-chat and the wizard's brand archetype should write **structured persona/toneConfig fields** the kernel already renders — not a `# Owner tuning` string glued to `systemPrompt`. This also lets post-deploy coaching modify the same fields (the flywheel).

## 2.5 What should disappear

- **The dead `/api/ai-agents/generate` endpoint** (live LLM spend, zero callers).
- **The env-flag autonomy model** as the source of truth (replaced by per-employee state; env flag remains only as a platform kill-switch).
- **The nine-SectionCard editor as the primary surface** (demoted to the Manage drawer).
- **The KB-less onboarding activation bypass** (unify on `draftReadiness`).
- **Compiled roles** (replaced by a `RoleDefinition` registry — the loop binding is already ~90% of the data target per the 2026-07-05 audit).

## 2.6 What should remain exactly as it is

The kernel and its guardrails; the approvals surface's explanation template; the readiness engine; the tool-surface AND-rule; the reachability-honesty pattern; deterministic escalation gates. **Correct — do not touch for novelty.**

---

# PHASE 3 — ROADMAP

> Sequencing law (inherited from the Product Bible and confirmed by this audit): **trust before scale; feel before breadth.** P1 is where adoption is won. Kernel frozen throughout — this is product surface + data + read-models.

## P0 — Quick wins: finish "honest," delete the dead (days)

**Objective:** close the residue the B-fixes left, remove footguns.
**Scope:** delete `/api/ai-agents/generate` [TD-2]; close the onboarding KB-less ACTIVE bypass — route onboarding creation through the same `draftReadiness` gate or seed a KB before activation [TD-3, B8]; fix `AgentToolPermission` unique key to include `aiAgentId` [TD-1]; surface reachability beyond the editor (a badge on the employee list + a post-`/complete` check) [UD-4, B1]; move onboarding tuned persona from `systemPrompt` append to structured fields [TD-4/§2.4 seed]; remove the builder's forbidden tools [TD-5]; per-user draft resume [TD-6]; delete the stray tmp artifact.
**Business/customer value:** the product stops contradicting itself; no silent KB-less agents; no double-grant races.
**Risk:** low; TD-1 is a schema migration (unique-key change) requiring a dedupe pass first. **Complexity:** S–M. **Dependencies:** none.
**Success criteria:** one activation rule across all three creation paths; zero KB-less ACTIVE agents creatable; reachability visible without opening the editor.
**Verification:** attempt KB-less activation on each path → all 422; create duplicate tool grant → DB rejects; onboarded employee's toneConfig contains tuned fields.

## P1 — Make it feel hired (the trust core — highest ROI)

**Objective:** the employee becomes a self the owner supervises into trust.
**Business value:** the adoption inflection; the differentiator no incumbent can copy; sells the second hire.
**Customer value:** "I watched it for a week and promoted it."
**Scope (in order):**
1. **Per-employee probation ladder** [PD-2] — add an `AIAgent` lifecycle/mode column; move Shadow→Assist→Autonomous off env onto owner-controlled, reversible per-employee state; graduation as a deliberate event backed by evidence.
2. **The living Employee Profile** [UD-1] — collapse the nine SectionCards into Overview/Today/Knowledge/Access/Performance + Manage drawer; **surface `AgentScore`** here [PD-3].
3. **The Shift Report + colleague-altitude decision timeline** [PD-3, UD-5] — proactive daily narrative from existing corpus; un-gate the timeline from ADMIN-only; add headline→reasoning→trace depth.
4. **Authority as an earned envelope** [PD-1] — money/irreversibility/reach limits + track record; approvals become the natural consequence; one-tap raises.
**Risk:** medium — probation touches the runtime branch (`ai-bot.service.ts:844-880`); mitigate by reading the new per-employee mode where the env flag is read today, defaulting to current behavior. **Complexity:** L. **Dependencies:** P0 (structured persona, unified activation).
**Success criteria:** an owner can graduate one employee Shadow→Assist→Autonomous from the UI and watch evidence accumulate; the Profile leads with life, not settings; a daily shift report lands; authority is a plain-language envelope.
**Verification:** E2E — hire → shadow a real conversation (see would-have-said) → promote → first approval → shift report next morning; confirm mode is per-employee (two employees, different stages) and reversible.

## P2 — Make it improve, and make hiring a hire (the flywheel)

**Objective:** the coaching loop + the unified hiring experience.
**Scope:** coaching store [PD-5] — capture every override/👎/edit as remembered coaching + a platform eval; show the override-rate-declining trend; unify the two creation doors into the spec's candidate→JD→offer flow [PD-4]; performance reviews framed as 1:1s [PD-3]; converge the copilot onto the one brain (per Product Bible G-Brain).
**Risk:** medium-high — coaching feeds prompt/memory (regression surface); gate on the eval corpus. **Complexity:** L. **Dependencies:** P1 profile + authority.
**Success criteria:** a correction visibly changes future behavior and appears as a logged rule; one hiring door; override-rate trend rendered.
**Verification:** correct an employee → same situation recurs → corrected behavior + visible "logged that rule"; hire from a job posting end-to-end.

## P3 — Make it scale (the org)

**Objective:** roles-as-data and the org layer.
**Scope:** `RoleDefinition` registry [PD-6] (loop binding already ~90% there); AI-native departments + shared knowledge/memory/policies; the AI Manager (an employee whose customers are escalations); offboarding + inheritance.
**Risk:** medium; mostly additive on the frozen kernel. **Complexity:** L. **Dependencies:** P1 (trust) + entitlements audit (AI-employee limits).
**Success criteria:** a new role ships as data, no code; 100-employee supervision-by-exception is coherent.
**Verification:** author a new role via registry and hire it; AI-manager escalates only above-line to the human.

---

# PHASE 4 — IMPLEMENTATION PLAYBOOK (for Claude Sonnet)

> NO CODE. Backend changes need `docker compose up -d --build <svc>` + `nginx -s reload`; shared/schema changes need `npm run db:generate` + `--no-cache ai` rebuild. **Never touch the frozen kernel internals, the guardrails, the tool-gate AND-rule, or the approvals explanation contract.**

## 4.1 Implementation order

**P0:** (1) unique-key migration (dedupe → migrate) → (2) unify activation (close onboarding bypass) → (3) delete `/ai-agents/generate` + stray tmp → (4) structured tuned persona → (5) reachability badge → (6) builder tool-surface trim + per-user draft resume.
**P1:** (7) `AIAgent` lifecycle/mode column + migration → (8) read per-employee mode where env flag is read → (9) probation UI (ladder on the employee card) → (10) Employee Profile IA (+ AgentScore surface) → (11) shift-report composer + un-gate/deepen timeline → (12) authority-envelope object + UI.
**P2:** (13) coaching store + capture wiring → (14) override-rate trend → (15) unified hiring door → (16) copilot convergence.

## 4.2 Key architecture decisions (made)

- **Probation location:** add `AIAgent.lifecycleStage` (enum: `probation_shadow|probation_assist|autonomous|paused|retired`) + `hiredAt`. The runtime branch (`ai-bot.service.ts:844-880`) reads this column first, falling back to the env flag only as a platform kill-switch. This is the minimal change that makes probation per-employee without touching kernel internals.
- **Authority envelope:** new `AgentAuthority` table (agentId, dimension money/irreversibility/reach, limit value, tier on-own|ask-first|never) + a `TrackRecord` view aggregating `ApprovalRequest` outcomes. Approvals continue to fire from `hitlPolicy` (unchanged) but the envelope is the owner-facing projection and the promotion target.
- **Performance:** roll up existing `AgentScore` rows into an `AIAgentPerformance` read-model (no new computation); the Profile Performance tab reads it; override-rate trend derives from approvals + coaching once P2 lands.
- **Coaching store:** new `AgentCoaching` table (agentId, sourceConversation, correctionType, before/after, generalizeScope) written from the existing override/edit/👎 paths; feeds both the employee's prompt context (structured, not string glue) and the eval corpus (reuse `reasoner_shadow_evals` intake).
- **Shift report:** a scheduled composer (reuse the nudge-engine BullMQ pattern from the onboarding side) reading `AgentLoopRun`+approvals+`AgentScore` → a plain-language artifact; delivered in-app + email.
- **Unified hiring:** onboarding MeetScreen/TuneScreen and the AI-Studio wizard both enter one candidate component; both call the same `draftReadiness`-gated completion.

## 4.3 Files likely affected

- **Shared:** `prisma/schema.prisma` (AgentToolPermission unique key; `AIAgent.lifecycleStage/hiredAt`; `AgentAuthority`, `AgentCoaching`, `AIAgentPerformance`); regenerate client.
- **AI service:** `ai-bot.service.ts` (read per-employee mode), `agent-config-generator.ts` (activation unification + structured persona), `routes/ai-agents.ts` (delete generate; reachability), `routes/decision-timeline.ts` (un-gate + depth), `agent-performance.service.ts` (rollup), new shift-report + coaching services.
- **Auth service:** `routes/onboarding.ts` (`hireRecommendedEmployee` structured persona; activation via shared gate).
- **Frontend:** `ai-studio/agents/[id]/page.tsx` (→ Profile), `AgentBuilder.tsx` (unified door), `analytics`/new Profile Performance tab (consume `getAgentScores`), approvals (authority track record), new probation ladder + shift report surfaces.

## 4.4 Database migrations (additive, except one unique-key change)

1. `AgentToolPermission` unique key → include `aiAgentId` (**dedupe existing rows first**; the only non-additive migration — do it in P0 with a dedupe script).
2. `AIAgent.lifecycleStage` (enum, default mapping current ACTIVE→`autonomous` or `probation_assist` per a chosen safe default), `hiredAt`.
3. `AgentAuthority`, `AgentCoaching`, `AIAgentPerformance` (all new, additive).
No destructive drops of the "dead" fields yet (they gained writers — TD-4); mark, don't drop.

## 4.5 API changes

- Delete `POST /api/ai-agents/generate`.
- `GET /api/ai-agents/:id/performance` (rollup), `GET/POST /api/ai-agents/:id/authority`, `POST /api/ai-agents/:id/graduate` (mode transition), `GET /api/ai-agents/:id/shift-report`.
- Un-gate `GET /decision-timeline/conversation/:id` from ADMIN → owner-role, with depth param.
- No changes to the kernel, guardrails, tool-gate, or approvals contracts.

## 4.6 AI changes

- No new LLM call types except the shift-report composer (lives in **services/ai** per CLAUDE.md). Coaching modifies structured persona fields the existing prompt-builder already renders — no prompt-architecture change. Readiness/tuning prompts untouched.

## 4.7 Regression risks

- **Runtime branch change (highest):** reading a per-employee mode where the env flag is read. Mitigate: default `lifecycleStage` maps to today's behavior; add a shadow-comparison on a pilot tenant before flipping any employee off the legacy default.
- **Unique-key migration:** must dedupe grants first or the migration fails; verify no permission is lost (findFirst-then-update code already tolerates it).
- **Structured persona vs existing `# Owner tuning` appends:** leave existing appends in place for already-deployed agents; apply structured path to new generations + explicit re-tune only.
- **Un-gating the timeline:** ensure tenant-scoping still holds (it does — `decision-timeline.ts` is tenant-scoped independent of the ADMIN check).
- **Copilot convergence (P2):** highest-risk; keep behind the eval gate.

## 4.8 Manual QA checklist

- [ ] Every creation path (wizard `/complete`, PATCH-promote, POST-ACTIVE, onboarding) rejects KB-less activation.
- [ ] Duplicate tool grant rejected by DB after migration; no permission lost.
- [ ] Onboarded employee's `toneConfig`/persona carries tuned fields (not just a systemPrompt append).
- [ ] Reachability visible on the employee list and after onboarding complete, not just in the editor.
- [ ] Probation: hire → shadow (see would-have-said on a real conversation) → promote to assist → first approval fires → promote to autonomous → demote back to assist. Two employees at different stages simultaneously.
- [ ] Employee Profile leads with Overview/Today; Performance tab renders real `AgentScore` data; config is behind Manage.
- [ ] Shift report lands next morning in-app + email, plain language, from real runs.
- [ ] Authority envelope: set "refunds ≤ $200 ask first"; verify an over-limit action escalates; grant a raise from the track record.
- [ ] Decision timeline visible to a non-ADMIN owner at headline depth; expands to trace.
- [ ] Coaching (P2): correct an employee → recurrence shows corrected behavior + logged rule; override-rate trend updates.

## 4.9 Automated testing checklist

- [ ] Migration dedupe test (duplicate grants → single row, no loss).
- [ ] Activation-gate parity test across all creation paths (KB-less → 422 everywhere).
- [ ] Per-employee mode read test (env flag no longer sole source; column wins).
- [ ] AgentScore rollup unit test; shift-report composer snapshot from a fixture run.
- [ ] Authority-envelope enforcement test (over-limit → approval; within-limit → act).
- [ ] Structured-persona mapping test (tune input → persona fields).
- [ ] Prompt snapshot for a fixture agent pre/post structured-persona change (no regression).
- [ ] `tsc --noEmit` clean; keep the kernel/shadow suites green.

## 4.10 Rollout / rollback

- **Rollout:** schema-first (additive + the dedupe'd unique-key change), code second, per-service rebuilds. Probation behind a per-tenant flag; default `lifecycleStage` = current behavior; flip pilot employees only after shadow parity. Profile/shift-report/timeline surfaces dark-linked behind env flags for one cycle. Coaching (P2) behind the eval gate.
- **Rollback:** revert image tags; additive tables inert when unread; the unique-key change is the only non-trivial rollback (keep the pre-migration dedupe report to reconstruct if needed); per-employee mode falls back to the env flag on any read error.

## 4.11 Definition of Done (per phase)

- **P0:** one activation rule everywhere; no KB-less ACTIVE agents; unique key fixed; dead endpoint gone; tuned persona structured; reachability surfaced outside the editor.
- **P1:** owner graduates an employee through the ladder from the UI; Profile replaces the settings page as the default; shift report + owner-altitude timeline live; authority is an envelope with a track record.
- **P2:** a correction demonstrably changes behavior and is logged; one hiring door; override-rate trend shown.
- **P3:** a role ships as data; the AI-manager escalates by exception.

---

# VERIFICATION CHECKLIST (audit integrity)

- [x] Every current-state claim cited to working-tree `file:line` (2026-07-08).
- [x] The 2026-07-05 engineering audit's B1–B8 re-verified against the working tree, not assumed: B2/B3/B4/B7/B8 fixed, B1 mitigated, B5/B6 substantially addressed via the kernel approval-resume path; documented per-blocker in §1.2 and the lifecycle table.
- [x] Stale prior-doc claims corrected: the status doc's "template marketplace" is in fact an **integrations** marketplace, not an employee-template gallery; the 07-05 docs predate the onboarding hire path.
- [x] Distinct from `docs/architecture/ai-employee-platform-audit.md` (engineering lens, kept) — this is the product lens at a new date.
- [x] No code, migrations, or tasks created. Cross-references: onboarding→employee handoff → `docs/product/onboarding-platform-audit.md`; AI-employee limits/metering → `docs/architecture/platform-entitlements-audit.md`; audit-log/tenant-isolation of these flows → `docs/security/enterprise-readiness-audit.md`.
