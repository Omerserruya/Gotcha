# Legacy → Kernel Operation Migration Roadmap

> **Migration unit = Operation. Execution unit = Conversation.** (User rulings 2026-07-01 / 2026-07-02.)
> **The FINAL architecture has NO router** - one brain (Employee→Reasoner→Capability Runtime→Observation→Reasoner) owns every conversation. The router is a **TEMPORARY migration component, optimized for deletion**: deterministic, tiny, no LLM. During migration it is the smallest safe thing - `agentKernelEligible(aiAgentId)`, an explicit operator opt-in via `AGENT_LOOP_AGENTS` (empty ⇒ no agent), mirroring `AGENT_LOOP_TENANTS`. The operator opts in only agents VERIFIED to need nothing beyond autonomous operations. One brain owns a whole conversation - never mixed. When `generateAIBotReplyInner` (Legacy) is deleted, the router + `operation-status.ts` + the env flag are deleted with it. Nothing here survives the migration.

## Per-operation lifecycle
`LOCATE` (find + understand the legacy responsibility, change nothing) → `MOVE` (into the Kernel, reuse Runtime/Oracle/integrations, don't rewrite) → `SHADOW` (run through the kernel, collect outcome evidence, fix regressions) → `AUTONOMOUS` (mark the operation autonomous-eligible; prefer READ before WRITE) → `DELETE` (once the Kernel is the SOLE production path for it - which for a whole family happens when its conversations route to the Kernel - delete the legacy implementation, run full regression) → `CONTINUE`.

Status ledger lives in code: `services/ai/src/services/agent-loop/operation-status.ts` (`OPERATION_STATUS`). Reporting per operation: operation migrated · legacy responsibilities removed · lines deleted · evidence collected · blockers · next operation.

> The former file-centric view (responsibility ledger below) is kept as the map of *where* each operation lives in the legacy brain (`generateAIBotReplyInner`, `services/ai/src/services/ai-bot.service.ts`, ~1104–3775).

## Status vocabulary
- **Legacy only** - only `generateAIBotReplyInner` does this; the kernel has no equivalent yet (usually because a capability isn't built).
- **Shadow** - the kernel already performs this (Reasoner / loop / a registered capability); it runs in SHADOW for the pilot, accruing outcome evidence. Legacy still serves production.
- **Production on Kernel** - the kernel is the *sole production path* for this responsibility (loop autonomous for the pilot).
- **Ready for deletion** - Production-on-Kernel + evidence sufficient; legacy code is now dead.
- **Deleted** - gone.

**Deletion rule (hard):** a responsibility may only be Deleted once it is *Production on Kernel* - i.e. the kernel is the SOLE production path for it. Nothing is deletable while legacy still serves it. Concretely: a legacy operation handler becomes deletable only once **some employee that needs it routes to the Kernel** (every operation that employee requires is autonomous) AND no employee still on Legacy needs it.

## The core insight
The kernel's **single Reasoner** subsumes the entire deterministic decision stack (BEL, Objective Engine, NBA, Action Preference, Failure Recovery, and the ~7 post-hoc gates). That is the bulk of the file (~1500 lines) and it is all **Shadow** today. But it cannot go Production-on-Kernel piecemeal: the loop can only drive a whole conversation once it has **every capability that conversation needs**. Today the loop has only CALENDAR. So the critical path is:

```
build missing capabilities (CRM, Knowledge, Custom)   ← unblocks the "Legacy only" rows
        ↓
loop can drive full conversations → accrue shadow evidence per responsibility
        ↓
promote pilot to AUTONOMOUS (loop = sole prod path)   ← flips Shadow rows → Production on Kernel
        ↓
delete the now-dead decision stack + tool paths        ← Ready for deletion → Deleted
        ↓
generateAIBotReplyInner has nothing left → delete the file
```

## Responsibility ledger

| # | Responsibility (ai-bot.service.ts) | Kernel equivalent | Status | Gate to advance |
|---|---|---|---|---|
| R1 | Behavior Engine / BEL decision (1319) | Reasoner (holistic decision) | **Shadow** | loop autonomous for full conv |
| R2 | KB retrieval (1363) | *Knowledge capability* (not built) | **Legacy only** | build Knowledge capability |
| R3 | Conversation memory / fact snapshot (1374) | Oracle customer/world facts | **Shadow** | - |
| R4 | Follow-up flow facts: WhatsApp 24h window + templates (1386) | channel-layer concern (not reasoning) | **Legacy only** | likely STAYS (channel layer, not brain) |
| R5 | Live-conversation facts / Objective Engine (1396) | Reasoner reads transcript + facts | **Shadow** | loop autonomous |
| R6 | Build system prompt (1410) | kernel Reasoner prompt | **Shadow** | loop autonomous |
| R7 | Tool surface / allowedActions (1423) | capability operation menu (generic) | **Shadow** (calendar) / **Legacy only** (crm/kb/custom) | build capabilities |
| R8 | Custom API tools (1626) | *Custom-HTTP capability* (not built) | **Legacy only** | build Custom capability |
| R9 | Custom DB tools (1645) | *Custom-DB capability* (not built) | **Legacy only** | build Custom capability |
| R10 | Adapter framework / CRM tools (1665) | *CRM capability* (not built) | **Legacy only** | build CRM capability |
| R11 | Unified semantic lead/contact creation (1776) | *CRM capability* (not built) | **Legacy only** | build CRM capability |
| R12 | Pipeline stage resolution (1898) | *CRM capability* (not built) | **Legacy only** | build CRM capability |
| R13 | Reasoner-shadow (1997) | the EVIDENCE mechanism | **KEEP - delete LAST** | migration complete |
| R14 | LLM tool-call loop + dispatch (2100–2460) | kernel loop + Runtime | **Shadow** | loop autonomous |
| R15 | Runtime contract enforcement (2463) | AUTHORIZE + invariants | **Shadow** | loop autonomous |
| R16 | Action Contract violations (2489) | invariants (per contract) | **Shadow** | loop autonomous |
| R17 | Action Preference / Unit B (2659) | Reasoner (re-roll on RIPE act) | **Shadow** | loop autonomous |
| R18 | Failure Recovery / Unit C (2870) | Reasoner re-reasons on observation | **Shadow** | loop autonomous |
| R19 | Objective-completeness gate (3087) | Reasoner decides FINISH | **Shadow** | loop autonomous |
| R20 | Guaranteed Background Actions / CRM integrity (3150) | Reasoner + *CRM capability* | **Legacy only** (CRM dep) | build CRM capability |
| R21 | Booking fail-safe gate (3320) | CalendarCapability invariants | **Shadow** | loop autonomous (calendar) |
| R22 | Booking-grounding gate (3372) | CalendarCapability + Reasoner | **Shadow** | loop autonomous (calendar) |
| R23 | Ledger consistency gate (3539) | Oracle re-read each iteration | **Shadow** | loop autonomous |
| R24 | Redundant info-request gate (3585) | Reasoner working memory | **Shadow** | loop autonomous |
| R25 | Conversation decision trace (3630) | agent_loop_iterations (kernel's own) | **Shadow** | loop autonomous |

## Rollup
- **Shadow (kernel-covered, evidencing): R1, R3, R5, R6, R7(calendar), R14–R19, R21–R25** - ~15 responsibilities, the deletable bulk. Blocked only by "loop autonomous for the full conversation," which needs the Legacy-only capabilities built.
- **Legacy only (no kernel capability yet): R2 (Knowledge), R8/R9 (Custom), R10/R11/R12/R20 (CRM), R7(crm/kb portion)** - the true build-work. R4 (WhatsApp window) likely stays as a channel-layer concern.
- **Keep until last: R13** (reasoner-shadow = the evidence mechanism).
- **Deleted so far:** **first IN-FILE deletions done 2026-07-02 (~196 lines):** two disabled-stub dispatch gates (`checkAllowedActionsGate`, `checkContractGate` - both returned `{blocked:false}` by prior user mandate, so their call sites were unreachable dead code) + the log-only `contractViolations` post-loop block (its force-retry was already removed). `generateAIBotReplyInner`/`ai-bot.service.ts`: 3988 → 3792 lines. tsc 0, full regression baseline held. Plus the ~760-line Slice 3B/3C teardown (separate scaffolding) - see `calendar-migration-register.md`. These are DEAD/NEUTERED responsibilities (the responsibility already left when the gate was disabled; this removes the husk), distinct from the "Shadow" rows which still need a production cutover.

## Critical path (next work, autonomous)
The single biggest unblocker is the **CRM capability** (R10/R11/R12/R20 + the CRM half of R7) - it's the largest Legacy-only cluster and gates the loop's ability to drive sales conversations. Build it plug-and-play (contracts + bindings + oracle `describeWorld` + register - zero kernel edits), shadow it, evidence it. Then Knowledge (R2), then Custom (R8/R9). Each capability built flips its rows Legacy-only → Shadow; going autonomous flips all Shadow → Production-on-Kernel → Ready-for-deletion.

**Reprioritization (2026-07-02): CRM is the real gate.** The whole Calendar operation set is now autonomous (CHECK+BOOK+MOVE+CANCEL, live-verified). But the pilot agent is a **sales employee** (probe: 3 calendar + 11 HubSpot CRM tools), not calendar-only - so it needs CRM operations the kernel can't do yet, and correctly stays on Legacy. There is **no calendar-only employee** to cut over. Therefore the first legacy deletion is gated on **CRM**, not on more calendar work or router cleverness.

**Next operation step:** migrate **`SEARCH_CUSTOMER` (CRM READ)** - build the CRM capability plug-and-play like Calendar (contracts + a port wrapping `getCrmAdapter(tenantId).findCustomer` + bindings + `describeWorld` + `registerCapability`, ZERO kernel edits), shadow it, evidence it, flip the READ. Then `CREATE_LEAD` / `ADD_NOTE` (WRITEs, live-verified like BOOK/MOVE). When the sales employee's whole op-set (SEARCH_CUSTOMER + CREATE_LEAD + ADD_NOTE + calendar) is autonomous, opt the agent into `AGENT_LOOP_AGENTS` → first cutover → delete the legacy calendar+CRM tool-dispatch (the first real legacy shrink).
