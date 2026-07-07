# Calendar Migration Register

> Living doc. The migration IS the evaluation. Nothing here is deleted until production/shadow evidence proves the Agent Loop is at parity. Every temporary bridge has an owner and a deletion gate.

## State (2026-07-01)

The production Calendar capability is **code-wired into the Agent Loop** and compiles + passes hermetic tests. The chain:

```
generateAIBotReply (ai-bot.service.ts:922)
  └─ AGENT_LOOP_MODE != off → runAgentLoopForBotTurn (bot-loop-adapter.ts)
       └─ runAgentLoop (agent-loop.ts)  [the kernel: PERCEIVE→DECIDE→AUTHORIZE→EXECUTE→observe→repeat→SPEAK]
            ├─ assembleOracleFacts → CalendarCapability.describeWorld (createProdCalendarPort — REAL)
            ├─ getReasonerProvider().reason (OpenAI)
            ├─ authorizeOperation (deterministic guardrail)
            └─ executeOperation → CalendarCapability.execute → executeCalendarOperation → resolveExecution (REAL runtime)
```

Verified: `tsc` 0 errors; shared 87/87; kernel/commerce/calendar suites 19/19. Mechanics proven with a fake port (identical path, only the provider differs).

## LIVE PILOT — evidence log (2026-07-01)

Driven by `services/ai/scripts/pilot-calendar-loop.ts` against the real dev DB + real OpenAI reasoner + real Google Calendar port. Pilot tenant `cmmov5qh10000ltnqm7pmxqzc`, agent `cm5aabb73f8d574c5b909ca1e9fcd6a142` (דניאל, CONNECTED Google Calendar), advisory mode (writes → RECOMMENDED via `resolver.ts:179`, so no real event is created).

**PROVEN end-to-end on real data:** incoming Hebrew request → Oracle (real `describeWorld` reading Google FreeBusy: `freeBusy.OK busy=2`, 3 genuine open slots) → OpenAI Reasoner → `CHECK_AVAILABILITY`/`BOOK_MEETING` proposed → deterministic AUTHORIZE → Capability Runtime executes → Observation → Oracle re-read → Reasoner re-decides → Writer → natural-Hebrew reply. Workflow EMERGES (one run: check→ask; another run: book→needs-email→ask). Full iteration trace persists. ~22–31s / 2 iterations / ~3.5–3.9k units per turn on gpt-5-mini.

**Bugs the pilot caught and FIXED (production-path, would have failed live):**
1. `bot-loop-adapter.ts` — `conversation.findFirst` / `message.findMany` omitted `tenantId` → TenantGuard blocked every turn. Fixed (added `tenantId` to both `where`s). Only ever passed before because hermetic tests bypass TenantGuard.
2. `persistence.ts` — `agent_loop_iterations.loop_id` FK to `agent_loop_runs`, but the run row was written LAST → every iteration insert violated the FK and was silently dropped (`persist iteration failed`), destroying the evidence contract. Fixed: `startLoopRun` (placeholder finals) up front so the FK holds, `finalizeLoopRun` (update by unique `loopId`) at the end. Iterations now persist; run is observable in-flight and survives a mid-loop crash. (Required `await writeReply` — trivial kernel plumbing to await an async final step, NOT a change to reasoning/control flow.)
3. Writer produced robotic English directive text (it rendered the Reasoner's `ReplyIntent` spec literally). Added an LLM Writer in `writer.ts` (metered through the same choke point, FAIL-SOFT to the deterministic renderer) → natural language in the customer's language. Verified: faithful, warm Hebrew reply. This is the "swap in an LLM Writer provider later" the file's own doc anticipated; isolated to `writer.ts` + the one `await`.

**Open CAPABILITY-level items (NOT kernel — do not block the kernel proof):**
- **Timezone presentation.** ✅ FIXED 2026-07-01. Added an optional `agentTimezone(ctx)` to `CalendarPort` (prod reads `meeting_types.agent_timezone`; optional so in-memory fakes are untouched — zero test ripple), surfaced into the CALENDAR world facts + summary via `describeWorld` (`facts.agentTimezone` + a "times are UTC ISO — present them in <tz>" note). The Reasoner now knows the agent timezone (Asia/Jerusalem) and maps/presents local time instead of asking. Combined with the `bad_iso_input` parse fix, the reasoner's `+03:00[Asia/Jerusalem]` timestamps also resolve. Verified: 24/24 calendar+kernel suites; live pilot.
- **FreeBusy failure degradation.** When the Google call fails (missing creds/expired token), `computeAvailability` returns no slots and the turn asks for clarification — safe (never fabricates availability), but the reply blamed a "full calendar" rather than a system issue. Port-level, shared with legacy; note only.

**Harness:** `services/ai/scripts/pilot-calendar-loop.ts` is a migration-evaluation tool (NOT product code). Deletion gate: removed when the loop is the production calendar path and the deletion gates below are green. Also spun a throwaway host Redis (`docker rm -f pilot-redis`) to silence transitive `voice-copilot-subscriber`/`live-stream-source` ioredis retries during host runs — remove at cleanup.

## ✅ DECISION MADE + IMPLEMENTED (2026-07-01): capability lifecycle off → shadow → autonomous

**User ruling:** option (A), renamed. The rollout modes are now **OFF → SHADOW → AUTONOMOUS** (the word "advisory" is retired as a rollout mode). This is the STANDARD migration path for EVERY capability (Calendar, CRM, Knowledge, Commerce, Voice) — the migration process itself is the validation framework. AUTONOMOUS is never a capability's first production execution path.

- **SHADOW = evaluation only.** The complete loop + Runtime run on real traffic (all observations/iterations/metrics/safety checks collected + persisted, writes dry-run to RECOMMENDED), but the customer NEVER sees the loop's output — the legacy brain stays the customer-facing source of truth. A capability graduates to AUTONOMOUS only after shadow evidence reaches confidence.
- **AUTONOMOUS = the loop drives the customer turn + executes real operations.**

**Implemented this session:**
- `agent-loop/flags.ts` — `AgentLoopMode = "off" | "shadow" | "autonomous"`; `AGENT_LOOP_MODE` accepts `shadow`/`autonomous`.
- `agent-loop/bot-loop-adapter.ts` — maps rollout `shadow` → runtime execution `advisory` (dry-run writes); `autonomous` → `autonomous` (real writes). (The runtime `ExecutionMode` contract is unchanged; `advisory` is the internal dry-run execution posture that `shadow` uses.)
- `ai-bot.service.ts:931` — `autonomous` returns the loop reply; **`shadow` fires the full loop OFF the critical path (fire-and-forget, no turn signal, fail-soft) and returns the LEGACY reply**, so shadow adds no latency and can't break or be seen by the customer.
- Verified: `tsc` 0; shared 87/87; ai kernel/commerce/scheduling/calendar-runtime suites all green.

**Follow-up (noted, not blocking):** shadow runs a full metered LLM loop per turn → it consumes the tenant's AI Units alongside legacy (≈2× on shadowed turns). Before enabling shadow at volume, decide whether shadow usage is exempt/tagged separately from billable customer usage (a metering-tag concern, not a kernel one).

---

### Original analysis (kept for provenance)

The live pilot surfaced a semantics gap that made a real-tenant flag-flip unsafe under the old "advisory" wiring:

- **Wiring reality (`ai-bot.service.ts:935-938`):** when `agentLoopMode(tenant) !== "off"`, the loop result is RETURNED DIRECTLY to the customer, replacing the legacy planner. So **advisory is NOT a silent shadow** — it is customer-facing with writes suppressed to RECOMMENDED.
- **Advisory write-goal artifact (observed live):** because advisory suppresses the write, the Oracle re-read never shows the booking, so the Reasoner re-proposes `BOOK_MEETING` every iteration until `max_iterations` (6 iters, ~9k units, ~59s) and the customer gets an "I'm trying to book…" reply while NOTHING is booked. This is inherent to a customer-facing advisory (it faithfully cannot show its own suppressed write), not a kernel bug.
- **Consequence:** flipping `AGENT_LOOP_MODE=advisory` for a real pilot tenant now would send real customers loop replies that, on any write-goal, are slow + misleading. That is a production-safety regression.

**Two valid directions (user's call — a stop-condition #3/#4):**
- **(A) Advisory = TRUE SHADOW.** Run the loop for logging/evidence, but the LEGACY planner still produces the customer reply. Zero customer impact; unlimited safe evidence on real traffic; matches the flags.ts comment ("safe way to watch loop behavior on real traffic"). Cost: both paths run per turn for pilot tenants. Requires a small wiring change (run loop → persist, return legacy).
- **(B) Advisory = customer-facing dry-run (current).** Keep as-is; only enable for a tenant whose owner accepts loop-driven replies with suppressed writes, AND first fix the write-goal loop (e.g. project RECOMMENDED as terminal-progress in advisory — but that makes advisory diverge from autonomous, weakening it as a faithful pre-autonomous shadow).

**Recommendation (owner): (A) TRUE SHADOW.** It strictly dominates for the stated purpose ("watch on real traffic") and is the only zero-customer-risk way to accrue the `agent_loop_iterations`/divergence evidence that gates every legacy deletion. Autonomous stays the real-execution step, gated behind the shadow evidence. **NOT implemented yet — awaiting the direction so I don't rewrite advisory semantics blind.**

**Meanwhile (safe, no flag-flip):** the harness (`pilot-calendar-loop.ts`) drives the loop directly and accrues real `agent_loop_runs`/`agent_loop_iterations` with zero customer exposure — this is how evidence is gathered until (A)/(B) is decided.

**Still the remaining validation (post-decision):** with (A), enable the loop-shadow for the pilot tenant so real inbound traffic accrues `agent_loop_iterations` at volume beside the legacy reply; compare; then autonomous for real execution. The harness proves the path; production traffic is the evidence that unlocks the deletions.

## OUTCOME-CENTERED EVIDENCE — batch 1 (2026-07-01)

**Evaluation is centered on OUTCOMES + SAFETY, not legacy agreement.** (Legacy agreement is a secondary debugging signal only — a divergence that reaches the same outcome more efficiently is an improvement, not a regression.) Primary metrics: goal advanced · invariants preserved · permissions respected · Runtime used correctly · response correct.

**Method (safe, no legacy re-execution):** `scripts/replay-compare.ts` runs the kernel in DRY-RUN SHADOW (writes → RECOMMENDED, verified zero real writes: bookings 5→5, outbound 22→22) over 8 REAL historical Hebrew conversations; `scripts/outcome-eval.ts` scores the persisted `agent_loop_*` trace — safety deterministically from the Runtime trace, goal/response via an LLM judge. Re-scores persisted evidence (cheap, re-runnable).

**Results (n=8 real conversations):**
| Metric | Result |
|---|---|
| SAFETY invariants preserved | **100%** |
| SAFETY permissions respected | **100%** |
| SAFETY runtime used correctly | **100%** |
| OUTCOME goal advanced | **100%** |
| OUTCOME response correct (strict judge) | 63% (5/8) |

**The 3 `responseCorrect` flags are NOT safety failures — examined:**
- `cmqqthbne` — kernel ESCALATED on a polite goodbye because the transcript claimed a moved meeting but the authoritative calendar showed `activeBooking:null`. The **legacy** brain had told the customer "moved to 24.06, here's the link" with **no `meeting_bookings` row** — a legacy PHANTOM booking. The kernel grounded in authoritative state and caught it. This is arguably SAFER than legacy, not a regression. (Judge only dinged it for naming the real customer in the internal handoff.)
- `cmqp707u` — proposed `desired_time 2026-06-23` (past) = replay-staleness artifact (June conversation replayed in July). BOOK stopped on `attendee_email_known:unsatisfied` before the time check; `scheduling.validateSlot` rejects past times anyway → **Runtime invariant is the backstop for a bad reasoner proposal (defense-in-depth verified).**
- `cmqqt1yu8` — finish-message asserted a calendar fact not authoritatively proven (minor faithfulness).

**Read:** safety is perfect on real traffic; goal advancement perfect; the response-faithfulness gap is dominated by replay-staleness + one case where the kernel out-performed legacy. **Methodology caveat:** replaying old conversations makes "today/tomorrow" resolve to the replay date, deflating faithfulness on stale dates — future batches should prefer recent conversations or inject the original turn's `now`. **Evidence is a START toward the deletion gate, not yet sufficient — accumulate more before deleting legacy.**

## ✅ COMPLETED DELETIONS (evidence-gated, verified)

**Deletion #1 — 3B shadow-compare (`calendar.shadow.ts`) — 2026-07-01.**
- **Responsibility removed:** "shadow-compare legacy calendar exec vs the Capability Runtime" — now owned entirely by the agent-loop SHADOW. Gate met: the old `shadowCompareCalendar` path was DEAD in production (`isCalendarShadowEnabled` ⇒ `CAPABILITY_RUNTIME_SHADOW !== "1"`, unset everywhere), so it was never a production path; the kernel's SHADOW is the sole shadow mechanism.
- **Deleted:** `services/ai/src/services/capability-runtime/calendar.shadow.ts` (271) + `capability-runtime.shadow.test.ts` (149) = **420 lines**, plus the dead `shadowCompareCalendar` block + `shadowOn`/`isCalendarShadowEnabled` in `ai-bot.service.ts`, its case in the e2e test, and the `isCalendarShadowEnabled` flag. ~470 lines net removed.
- **Kept (verified live):** the reasoner-shadow (evidence mechanism) — disentangled at `ai-bot.service.ts` line ~2022 (`runtimePlan` now gated on `calRuntimeOn || isAgentArchitectureEnabled()`), `shadowTurnId` audit join-key retained.
- **Verification:** `tsc` 0 · 68 tests green · live SHADOW run healthy. **Gotcha found + applied:** the copilot path (`openai.provider.ts`) calls `executeCalendarToolAdvisory` UNCONDITIONALLY (`if (isCalendarTool)`, not flag-gated) → `calendar.execute.ts` is a LIVE production path and must NOT be deleted. The "sole production path" rule prevented a bad deletion.

**Deletion #2 — pre-LLM calendar read (`calendar.preresolve.ts`) — 2026-07-01.**
- **Responsibility removed:** "pre-resolve calendar availability before the LLM and inject it as authoritative facts" — the loop's `CalendarCapability.describeWorld` performs this Oracle read every iteration. Gate met: all three call sites (employee `calRuntimeOn`, both copilot `isCalendarRuntimeEnabled`) were flag-gated OFF → dead, not a production path.
- **Deleted:** `calendar.preresolve.ts` (73) + employee block in `ai-bot.service.ts` + both copilot blocks in `openai.provider.ts` (28) + e2e case + orphaned imports ≈ **~130 lines**. `isCalendarRuntimeEnabled` import removed from `openai.provider.ts` (now unused there).
- **Verification:** `tsc` 0 · 88 tests green (67 core + 21 copilot) · live SHADOW healthy.
**Deletion #3 — dead employee runtime-cutover + flag cascade — 2026-07-01.**
- **Responsibility removed:** the employee-side AUTONOMOUS calendar-tool-via-runtime cutover (`executeCalendarToolViaRuntime`) — the employee now books through the Agent Loop's CalendarCapability. Gate met: the branch was `calRuntimeOn && …` with `calRuntimeOn` always false → dead. Replacing the ternary with the plain `dispatchToolCall(...)` is behavior-preserving (that branch always ran).
- **Cascade removed once the last caller was gone:** `calRuntimeOn`, `SHADOW_CALENDAR_TOOLS`, `shadowProdPort`, `shadowPlannerGoal`, the `createProdCalendarPort`/`executeCalendarToolViaRuntime`/`isCalendarRuntimeEnabled` imports in `ai-bot.service.ts`; `executeCalendarToolViaRuntime` + `RuntimeExecInput` + `toLegacyContent` + the `AgentToolDispatchResult` import in `calendar.execute.ts`; and **`capability-runtime/flags.ts` deleted entirely** (both `CAPABILITY_RUNTIME_*` flags gone). `runtimePlan` now gated purely on `isAgentArchitectureEnabled()` (reasoner-shadow).
- **Kept (LIVE, verified):** `executeCalendarToolAdvisory` + `isCalendarTool` in `calendar.execute.ts` — the copilot's unconditional advisory calendar path.
- **Deleted ≈ 160 lines** (flags.ts 26 + calendar.execute.ts −66 + ai-bot ~50 + e2e ~20). **Verification:** `tsc` 0 · 87 tests green · live SHADOW healthy.

**RUNNING TOTAL (deletions #1–#3): ~760 legacy lines removed. The dead Slice 3B/3C calendar scaffolding is now fully gone** (`calendar.shadow.ts`, `calendar.preresolve.ts`, `calendar.execute.ts`'s runtime-cutover half, `flags.ts`). **Deletion #4 (config) — 2026-07-01:** the now-dead `CAPABILITY_RUNTIME_CALENDAR*` / `CAPABILITY_RUNTIME_SHADOW*` env vars removed from `docker-compose.yml` (nothing reads them since `flags.ts` was deleted). `docker compose config` valid. **Slice 3B/3C is now fully gone from code AND config** — a repo grep finds only doc-comment mentions.

## Operation migration log

### 2026-07-02 — Employee-descriptor router + BOOK_MEETING write-path evidence

**Router refinement (user ruling): routing unit = EMPLOYEE, not domain.** The router is now a pure employee-descriptor evaluator — `routeEmployee({requiredOperations}) === "kernel" iff requiredOperations.every(isOperationAutonomous)` (`agent-loop/operation-status.ts`). It carries NO domain knowledge (no `if calendar/crm/...`), only Employees and Operations. A new capability adds operations to the ledger; the router is untouched. `tsc` 0, `operation-status.test.ts` 5/5 (incl. scheduling-only→kernel, sales(shadow op)→legacy, support(unknown op)→legacy, empty→legacy). NOT yet wired into `generateAIBotReply` — deferred until the first employee's full op-set is autonomous (wiring inert code now would be untestable). Full ai suite: 896 pass / 18 fail = the known crm-panel DB-drift baseline (no agent-loop/runtime failures).

**CHECK_AVAILABILITY:** autonomous (READ), unchanged.

**BOOK_MEETING write-path shadow evidence** (`scripts/book-evidence.ts`, over 48 persisted iterations): 24 BOOK proposals — **0 EXECUTED** (dry-run correct for shadow), 11 would-execute (RECOMMENDED), 13 correctly gated NEEDS_INPUT on missing attendee email, **0 malformed runtime, 0 MUST-invariant violations**. Anomaly: 2 would-execute proposals show `time_genuinely_open:skipped_should` with no CHECK earlier in-loop.
- **Root-caused — NOT a safety gap.** `time_genuinely_open` is SHOULD *by deliberate, tested design*: the resolver auto-runs its satisfier (CHECK_AVAILABILITY) and re-verifies; if the slot is still genuinely closed the SHOULD proceeds, but the **strategy layer rejects a taken slot with `time_taken`** (proven by `calendar.test.ts:102`) and `createEvent`/`makeScheduleMeetingHandler` defers via `needsAvailabilityCheck`. An autonomous book of an unavailable slot would FAIL → loop recovers → never a double-book. `single_meeting_after` (POST MUST) + `no_duplicate_meeting` (PRE MUST) are the integrity envelope.
- **Decision: did NOT change `time_genuinely_open` SHOULD→MUST.** Production has not proven a weakness (backstop works); the SHOULD-never-blocks behavior is a deliberate design with its own tests. Reversing it would over-engineer and risk blocking legitimate bookings on `isTimeOpen` false-negatives. Prefer service correctness; don't optimize the contract without a proven weakness.
- **Remaining gate for BOOK autonomous:** shadow has only ever *dry-run* BOOK (RECOMMENDED). Before flipping (a real-side-effect op), verify **one controlled live autonomous booking** on the pilot (real event created, invite sent, `single_meeting_after` holds), then clean up the test event — the write-op analogue of how CHECK was verified live before its flip. That is the next operation step.

**Legacy shrink this iteration: 0 lines** (honest). Deletion is gated on routing; routing is gated on a fully-autonomous employee; no employee is fully autonomous yet (BOOK/MOVE/CANCEL still shadow). No fake progress.

### 2026-07-02 (cont.) — Calendar WRITE set verified LIVE → all 4 ops autonomous

Drove the **exact production pipeline** (`executeCalendarOperation` → prod `CalendarPort` → real Google Calendar) in `mode:"autonomous"` on the pilot tenant, throwaway customer, with full cleanup (`scripts/pilot-book-verify.ts`, `scripts/pilot-move-verify.ts`):
- **BOOK_MEETING** — real `events.insert` (eventId `27sqml…`), invite sent, all 6 invariants held incl. `time_genuinely_open:held`, `single_meeting_after:held`; store recorded 1 active. **CANCEL** — real `events.delete`, store CANCELLED, 0 residual.
- **MOVE_MEETING** — real `events.patch` slotA→slotB, store updated, exactly 1 booking now at slotB, invariants held (`existing_booking_present`/`booking_unambiguous`/`new_time_provided`/`new_time_genuinely_open`/`single_meeting_after`). Cleanup real-deleted, 0 residual.
- The `time_genuinely_open`/`new_time_genuinely_open` guards held (probe-first: already satisfied by the CHECK), confirming the SHOULD design is fine and a taken slot is rejected at the strategy (`time_taken`) — never a double-book.

**Ledger flipped: BOOK/MOVE/CANCEL → autonomous.** `operation-status.ts` now has the whole CALENDAR set autonomous; `tsc` 0, ledger tests 5/5 (updated: scheduling employee {CHECK,BOOK,MOVE,CANCEL} → kernel; sales +SEARCH_CUSTOMER → legacy).

⚠️ **SAFETY GATE — do NOT set `AGENT_LOOP_MODE=autonomous` for any tenant until `routeEmployee` is wired into `generateAIBotReply`.** With the ops autonomous but the router unwired, the current `if (loopMode==="autonomous")` branch would route EVERY conversation (incl. CRM/support the kernel can't do) to the kernel. It is safe today only because the pilot is `shadow`. The router is the cutover safety mechanism.

### 2026-07-02 (cont.) — Router = TEMPORARY migration component; shrunk; CRM is the real gate

**User ruling: the Router is NOT part of the final architecture — it is migration-only, optimized for DELETION.** Final arch = Employee→Reasoner→Capability Runtime→Observation→Reasoner (one brain, NO routing). No LLM in routing during migration; keep it deterministic + extremely small + temporary; delete migration code as confidence grows. If a migration component grows complex → stop (we'd be rebuilding a second architecture).

**Acted on it — shrank the router.** Deleted the `EmployeeDescriptor` / `routeEmployee` / `RoutingBrain` / `conversationEligibleForKernel` abstraction (premature routing architecture). `operation-status.ts` is now a TEMPORARY file with a header deletion-condition and just: (1) `OPERATION_STATUS` flat progress ledger (telemetry), (2) `agentKernelEligible(aiAgentId)` — the entire routing floor: an explicit operator opt-in via `AGENT_LOOP_AGENTS` (comma-sep agent ids; empty ⇒ NO agent; no wildcard), mirroring `AGENT_LOOP_TENANTS`. Wired as the ONLY gate on the autonomous branch in `generateAIBotReply` (`kernelDrivesTurn = autonomous && agentKernelEligible`); an autonomous-mode agent not opted in still runs SHADOW. `tsc` 0, floor tests 4/4.

**Reality check (agent-tools probe): the pilot agent is a SALES employee, not calendar-only** — 14 enabled tools = 3 google_calendar + 11 HubSpot CRM (create_lead/contact/deal, search/get/update_contact+lead, log_activity, describe_fields). So its conversations may need CRM operations, which are NOT autonomous. **There is no calendar-only employee to route → the floor correctly routes NOBODY today**, and the first legacy deletion is gated on **CRM**, not on routing cleverness. Calendar being fully autonomous only matters once an employee's *whole* need is autonomous.

**Next operation (pivot to CRM): `SEARCH_CUSTOMER` (READ)** — LOCATE the legacy CRM search (fragmented: crm-prefetch `findCustomer` + vendor `*.search_customers` + `system_search_customers`), then build the CRM capability plug-and-play like Calendar (contracts + port wrapping `getCrmAdapter(tenantId).findCustomer` + bindings + `describeWorld` + register — ZERO kernel edits), shadow it, evidence it, flip READ. That widens the ledger; when the sales employee's whole op-set (SEARCH/CREATE_LEAD/ADD_NOTE + calendar) is autonomous, opt it into `AGENT_LOOP_AGENTS` → first cutover → delete legacy calendar+CRM tool-dispatch.

### 2026-07-02 (cont.) — CRM capability DRIVER built (SEARCH_CUSTOMER, shadow)

**User ruling: a capability is a DRIVER (like a hardware driver) — describeWorld · expose operations · execute — that WRAPS existing production code. No reasoning/planning/workflow/orchestration (those are the Reasoner's). Adding an integration = contracts + port + bindings + describeWorld + registerCapability; if it needs touching Reasoner/Loop/Runtime/Oracle/Prompt/Guardrails, STOP — the abstraction isn't generic enough. Migration is responsibility-driven: each iteration answers "what production responsibility permanently moved from Legacy to the Kernel today?"**

Built the CRM driver, ALL in `services/ai` (kernel + shared untouched; only the shared *types* imported):
- `capability-runtime/crm.port.ts` (abstract: `connection` + `searchCustomer`), `crm.port.prod.ts` (wraps `getCrmAdapter().findCustomer` + `resolveCrmVendor` — no reimplementation), `crm.contracts.ts` (`SEARCH_CUSTOMER`, business-only, READ, PRE `search_key_known`→NEEDS_INPUT), `crm.runtime.ts` (binds via the shared `resolveExecution`), `capability-plane/crm.capability.ts` (the driver: describeWorld + ownsOperation + execute).
- Registered with ONE line in `capability-plane/index.ts` — zero kernel edits (the plug-and-play contract held: agent-loop/capability/kernel/commerce-e2e suites 57/57 green, proving `describeAllWorlds` tolerated the new driver).
- Added `resolveCrmVendor` to the resolver (behavior-preserving refactor — `getCrmAdapter` diff shows `resolveFromDb` untouched) because the NoOp adapter reports a placeholder vendor.
- Ledger: `SEARCH_CUSTOMER: "shadow"`. `tsc` 0; new `crm-capability.test.ts` 7/7. Full suite noise (18↔19 fail) is pre-existing DB/mock-drift baseline — behavior-engine/integration-verification import none of my code; crm-adapter.smoke's `CalledTimes(1)` fails on `resolveFromDb`'s two `findFirst` calls, which I did not touch.

**Live evidence (real HubSpot):** resolveCrmVendor→hubspot; describeWorld→connected + exposes SEARCH_CUSTOMER; missing-identifier→NEEDS_INPUT(contact_identifier). First run FAILED `unknown_provider:hubspot` — a HARNESS bootstrap gap (provider adapters self-register via `import "connectors"`, which the service does at boot but the standalone harness didn't), NOT a driver/production defect. After adding that import: **SEARCH_CUSTOMER EXECUTED against real HubSpot** — `search_key_known:held`, `executed=true`, `successVerified=true`, `matchCount=0` for a non-existent test email (a real query that ran and correctly found no match). Proves the driver faithfully wraps the production adapter end-to-end (`scripts/pilot-crm-search-verify.ts`).

**Responsibility moved this iteration: 0** (SEARCH_CUSTOMER is shadow; Legacy still owns CRM search until the sales employee cuts over). The driver is the necessary setup; responsibility moves at cutover.

### 2026-07-02 (cont.) — UPSERT_CUSTOMER (CRM WRITE, shadow) — identity foundation

**User ruling: migrate UPSERT_CUSTOMER BEFORE CREATE_LEAD** — customer identity is the foundation of every CRM workflow; once resolution + upsert are autonomous, every other CRM write is simpler and more reliable. Priority order restated: move responsibility → collect evidence → delete legacy → only then terminology.

Wrapped the production identity flow `linkOrCreateCrmContact` (`crm-identity.service.ts` — the 0/1/2+ reconciliation used by every inbound path: 0→create, 1→enrich, 2+→merge-or-`needs_approval`). Added `upsertCustomer` to the CRM port + prod wrapper (`allow_auto_merge:false` keeps irreversible merges operator-gated, CLAUDE.md rule #9), `UPSERT_CUSTOMER` contract (WRITE; PRE `identity_known`(email|phone)→NEEDS_INPUT; success `customer_record_resolved`), runtime outcome mapping (created/linked/merged→EXECUTED; `needs_approval`→FAILED-recoverable `ambiguous_identity_needs_operator` so the loop escalates and NEVER guesses an identity). Ledger `UPSERT_CUSTOMER:"shadow"`. `tsc` 0; `crm-capability.test.ts` 13/13 (6 new); full suite 908 pass / 18 known-baseline fail (0 new regressions; earlier 19/8 was DB-flaky, back to 18/7).

**Live SAFE-verified real HubSpot** (`scripts/pilot-crm-upsert-verify.ts`, no mutation): describeWorld connected + exposes SEARCH+UPSERT; advisory(shadow) WRITE → RECOMMENDED `executed=false` (no mutation); no-identifier → NEEDS_INPUT.

**Autonomous-flip blocker (honest):** the CRM connector has NO delete/archive, so a real `created` would leave an uncleanable contact in the live customer HubSpot — unlike BOOK (clean cancel). So the real create/enrich happy-path is NOT live-run yet. Flip is gated on a controlled real-write verification WITH a cleanup path (direct HubSpot archive `DELETE /crm/v3/objects/contacts/{id}`) or a disposable CRM; HubSpot write scopes were also historically 403-broken on this pilot (config).

**Responsibility moved this iteration: 0** (shadow). NEXT: cleanup-capable autonomous UPSERT verify → flip SEARCH+UPSERT autonomous → CREATE_LEAD + ADD_NOTE (simpler now — they consume UPSERT's resolved contact_id).

### 2026-07-02 (cont.) — ADD_NOTE (CRM WRITE, shadow) + user ruling: infra must not gate architecture

**User ruling: prove the KERNEL, not HubSpot. The connector is an implementation detail — do NOT let real CRM writes bottleneck the migration.** Migrate all READ ops first; move responsibility wherever real side effects aren't required; for WRITEs, BUILD + SHADOW + evidence against the production implementation, but leave end-to-end live-write verification as the FINAL step for when a disposable CRM exists. Only an unresolved architectural question stops progress — never a missing sandbox.

**HubSpot write scopes probe inconclusive** (granted scopes aren't persisted, only tokens) + connector has no delete → a real autonomous create would leave an uncleanable contact in the live customer CRM → autonomous CRM-write live-verify **deferred** to a disposable CRM.

**Built ADD_NOTE** wrapping `adapter.createNote` (crm.port `addNote`; contract: WRITE, PRE `contact_known`→NEEDS_INPUT(contact_id) with NO satisfierOperation — resolving identity is a WRITE and the runtime must never auto-run a write to satisfy a precondition; the Reasoner sequences UPSERT→ADD_NOTE — plus `note_body_present`; success `note_recorded`). Ledger `ADD_NOTE:"shadow"`. `tsc` 0; `crm-capability.test.ts` 18/18; full suite 913 pass / 18 baseline.

**CREATE_LEAD (resolved, non-blocking):** UPSERT_CUSTOMER already does dedup-aware create-or-resolve of the customer record, so "create the lead/contact record" is covered. A distinct CREATE_LEAD (separate Lead *object* vs Contact) is added only if a tenant models Leads separately — deferred to avoid duplicating UPSERT.

**Sales-employee CRM op-set now BUILT + shadow-ready: SEARCH_CUSTOMER (read) + UPSERT_CUSTOMER (write) + ADD_NOTE (write); calendar set already autonomous.** The only remaining gate to the sales-employee cutover — where production responsibility actually leaves the legacy brain — is end-to-end live-write verification of the CRM writes on a disposable CRM. **Responsibility moved this iteration: 0** (shadow; honest).

## Deletion candidates (marked, NOT yet removed)

| Legacy component | Why redundant | Evidence required before deletion | Owner |
|---|---|---|---|
| `capability-runtime/calendar.preresolve.ts` (`preResolveCalendarRead`) | Pre-LLM calendar read inside the legacy brain. The loop's `CalendarCapability.describeWorld` performs the Oracle read every iteration. | Loop is the production calendar path for the pilot tenant; ≥N live turns show the loop's Oracle read yields the same availability facts the preresolve did. | migration |
| `capability-runtime/calendar.shadow.ts` (`shadowCompareCalendar`) | Was the legacy-brain shadow comparing legacy calendar exec vs runtime. The loop supersedes the legacy calendar exec entirely. | Loop autonomous for calendar on pilot; no divergence rows attributable to calendar execution. | migration |
| `capability-runtime/flags.ts` (`isCalendarRuntimeEnabled`, `isCalendarShadowEnabled`) | Old per-capability slice flags, superseded by `AGENT_LOOP_MODE` + `AGENT_LOOP_TENANTS`. | The two legacy calendar-slice call sites above are deleted. | migration |
| Legacy calendar tool path in `generateAIBotReplyInner` (schedule_meeting/reschedule/cancel through BEL + tool-gate + orchestrator) | The loop proposes `BOOK_MEETING`/`MOVE_MEETING`/`CANCEL_MEETING` operations directly through the Capability Runtime. | `agent_loop_iterations` show the loop books/moves/cancels at parity with the legacy tool path over real traffic; no regressions in booking integrity (MeetingBooking store). | migration |
| `reasoner/shadow-runner.ts` + `oracle-producer.ts` (Planner↔Reasoner decision shadow) | This is the EVIDENCE mechanism, not dead yet. Becomes redundant once the loop is the driver (the reasoner IS production; comparing to the legacy planner is moot). | Loop is the production path; migration complete for all capabilities. **Delete LAST.** | migration |
| `TOOL_TO_OPERATION` (duplicated in calendar.shadow.ts, calendar.execute.ts, shadow-runner.ts) | Legacy tool-name→operation-name bridge. The loop uses operation names directly. | The legacy tool-based paths that need it are deleted. | migration |

## Temporary bridges (with removal plans)

| Bridge | Purpose | Removal point |
|---|---|---|
| `bot-loop-adapter.ts` | Maps a bot turn → `AgentLoopInputs` and the loop result → legacy `AIBotReplyResult`. | When the legacy reply path (`generateAIBotReplyInner`) is removed and the worker consumes the loop result shape directly. |
| `oracle-producer.ts` "AGENT" single-world projection | Projects a Planner turn into one `CapabilityWorldView` for the decision shadow. | Deleted with the Planner↔Reasoner shadow (last). |

## Hardening prerequisites BEFORE broadening beyond a pilot

1. **RBAC in the loop (production-safety).** The loop's `authorizeOperation` enforces RBAC when `permissions.allowedOperations` is non-empty, but `bot-loop-adapter` currently passes `[]` (= allow-all). Acceptable for the single trusted pilot tenant (user-authorized); **must be closed before any broader rollout.**
   - **DECISION (user, 2026-07-01): option (a) — the RBAC bridge — as a MARKED MIGRATION ADAPTER only.** The adapter reads `agentToolPermission`, maps each permitted tool→operation (via `TOOL_TO_OPERATION`), and feeds `allowedOperations`. It reuses legacy RBAC for speed. It is explicitly NOT part of the long-term kernel.
   - **Permanent architecture: (b) capability-native** — each operation/capability declares its required permission/feature and the guardrail plane checks it. The bridge is replaced by this and deleted.
   - **Deletion gate for the bridge:** removed once capability-native permissions land AND the loop is the production path for ≥1 capability under real RBAC. Owner: migration.
   - **Sequencing:** deferred until the broadening step (not built for the single-tenant pilot, where it would be untestable dead code — allow-all is correct and authorized there). Built + tested when the first non-pilot tenant is enabled. Tracked here so it is never forgotten.
2. **Customer facts:** surface on-file email/phone into `customer.knownFields` so the Reasoner has accurate identity (today it asks when missing — safe, just chattier).
3. **Committed-goal continuity:** the legacy path resumed a per-customer goal across conversations; the loop passes `goal: null`. Parity item, not a safety item.
