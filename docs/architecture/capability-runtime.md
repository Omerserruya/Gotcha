# Capability Runtime — Architecture Design (FROZEN)

> Status: **Model frozen 2026-06-27. Design only — not implemented.**
> Rollout: CALENDAR pilot first, then decide migration shape.
> Core principle: **LLM owns meaning. Runtime owns mechanics. The Planner decides WHAT
> should happen; the Runtime guarantees THAT it happened correctly.**

## Why

The planner today names a concrete tool (`schedule_meeting`), fusing business reasoning
with execution; the read-before-write protocol lives only as prose, so the LLM can narrate
"I'll check availability" without ever checking (root cause of the "I'll check" /
invented-slot / duplicate-booking bugs). Prerequisite checks already exist but reactively,
per-handler, and re-delegated to the LLM. The Capability Runtime separates business
reasoning (LLM/planner) from execution (runtime), behind one contract every execution mode
shares: AI Employee, Copilot, Workflow engine, MCP, external APIs, future AI workers.

## The architectural principle (mechanical test)

- Does this require understanding what the customer **meant**, or a value judgment? → **LLM/Planner.**
- Does this depend on system state, dependencies, capabilities, policies, APIs, execution? → **Runtime.**

The Planner decides **what** should happen. The Runtime guarantees **that it happened
correctly** — and never decides whether/which/at-what-cost.

## Layer model

```
  Business Goal              (LLM reasoning; e.g. "get a qualified demo booked")
        |                      LLM owns selection of meaning
  Execution Intent           (LLM emits: Operation + meaning-level params)
  ======================= CONTRACT BOUNDARY =======================
  Operation Contract         (semantic contract: meaning-face + runtime-face)
        |
  Strategy Resolver          (runtime picks a strategy that can satisfy THIS contract, this tenant)
        |
  Execution Strategy         (provider tools | workflow | MCP | AI worker | future)  <- interchangeable
        |
  Invariant Verification     (runtime checks MUST invariants + success vs world-state, every strategy)
        |
  Tool(s)                    (never visible above the boundary)
```

## What is / is not an Operation

- **Business Goal** — multi-turn outcome reached by reasoning (`QUALIFY_PROSPECT`,
  `RESOLVE_SUPPORT_REQUEST`). Owned by LLM. NOT in the operation vocabulary.
- **Conversation move** — ask/explain/acknowledge. Owned by LLM. Not an operation.
- **Execution Operation** — a discrete runtime transaction against state/world with a
  semantic outcome (`MOVE_MEETING`, `GET_ORDER`, `ISSUE_REFUND`). Owned by runtime.

Definition: *the smallest unit of world-change/read the platform can guarantee, name in
business terms, and report a semantic outcome for — independent of provider or tool.*

## Carving principle (assertion-based)

> Carve a separate operation wherever the requester **asserts something different about
> world-state**, because that changes the dependency contract and the error semantics.

- `MOVE_MEETING` vs `BOOK_MEETING` -> separate: MOVE asserts a booking exists
  (required dependency; absence is an error); BOOK asserts only a desire (active booking
  is a collision guard). Different assertion -> different contract.
- `CAPTURE_LEAD` vs `UPDATE_CUSTOMER` -> collapse to `UPSERT_CUSTOMER`: no differing
  assertion about existence; create-vs-update is a probe (mechanics).

Granularity ceiling: small, curated vocabulary; merge aggressively via this rule.

## Operations are semantic contracts (not callable units)

A contract expresses business **invariants** — predicates that must hold — never steps.
A step prescribes HOW (rejected: that is a workflow). An invariant is a truth the runtime
**checks**, free to satisfy any way.

### Two faces

| Public face (meaning — Planner sees) | Runtime face (mechanics — hidden) |
|---|---|
| meaning — what the requester wants | goalState — target world-state |
| params — meaning-level inputs | success — predicate over world-state |
| outcome — semantic result to narrate | failureModes, invariants, recoveryPosture, approval, dedupKey |

The planner never sees an invariant; it emits the intent and consumes the semantic result.
Success/failure is the runtime's determination against the world, not something the LLM tracks.

### Invariant dimensions

- **strength**: `MUST` (hard; violation aborts) | `SHOULD` (normative; may skip with a logged reason)
- **checkpoint**: `PRE` | `POST` | `DURING`
- **enforcement**: `RUNTIME_VERIFIED` (checkable vs world-state, any strategy) | `PROVIDER_ATTESTED`

**Dependencies are a special case of invariants:** a PRE invariant with a known
read-operation satisfier (`availability` = "the chosen time is genuinely open", SHOULD,
satisfier `CHECK_AVAILABILITY`). The dependency resolver is one mode of invariant satisfaction.

## The frozen principles

1. Goal -> Operation -> Strategy -> Tool. LLM reasons in Goals, emits Operations.
2. Operations carved by **assertion** (differing world-state claims).
3. Operations are **semantic contracts** with a meaning-face and a runtime-face.
4. Invariants are **predicates, not steps** (strength / checkpoint / enforcement). MUST => RUNTIME_VERIFIED.
5. **Leak test**: `success` and every `MUST` reference world-state only, never a tool.
6. Strategies are **interchangeable and verified** -> the same Operation can be fulfilled by
   provider / workflow / MCP / AI-worker / future strategy WITHOUT touching the Planner or LLM. **Yes.**
7. **Correctness envelope = MUST invariants + success.** It bounds the optimizer; everything
   inside is free; the envelope itself is non-bypassable (re-verified at POST regardless of path).
8. Runtime **guarantees, never decides.** Recovery bottoms out by returning control to the planner.

## Constraint A — contracts stay business-owned

1. **Product test / lint**: a contract is invalid if it contains any implementation token
   (tool name, provider name, endpoint, protocol). It may reference only business state and
   other operations. Greppable; enforced in review.
2. **Dependency direction**: the contract layer imports nothing from providers/strategies/
   adapters/SDKs. `strategies -> contracts`, never reverse. Contracts live in `packages/shared`
   with zero execution deps; a provider import in a contract fails the build.
3. **Business-state oracle**: `success` asks a business question ("a confirmed meeting exists
   for this customer"); a runtime oracle translates it to a store/provider query. The predicate
   never knows where the truth lives.

## Constraint B — runtime free to optimize

The correctness envelope (MUST + success) is the only bound. Inside it the runtime may:
skip fresh reads (probe-first), batch invariants into one call, parallelize independent PRE
invariants, cache reads, switch providers, delegate strategies. Safe because POST re-verifies
the envelope against world-state regardless of the path taken. The contract constrains
**correctness, never optimization**.

## Runtime guarantees, never decides

Runtime decisions are limited to: strategy selection, invariant ordering/optimization,
verification. Recovery within `recoveryPosture` is mechanical-gather (retry / re-verify /
gather alternatives as data); anything customer-facing or judgment-laden returns to the
planner as `FAILED`/`NEEDS_INPUT` carrying the data. Litmus: if proceeding needs customer
meaning or a value judgment, the runtime stops and returns to the planner.

## Execution Contract (the universal entry)

```
ExecutionRequest = { operation, params(meaning), context, mode }
ExecutionResult  = EXECUTED{outcome} | NEEDS_INPUT{field,reason}
                 | RECOMMENDED{proposal} | AWAITING_APPROVAL{ref}
                 | BLOCKED{reason} | FAILED{reason, data?, recoverable}
```

Mode parameterizes only the eligibility/approval/execute stages:

| Mode | Reads | Writes | Caller |
|---|---|---|---|
| autonomous | auto-run | execute (HITL if policy) | AI Employee loop |
| advisory | auto-run | short-circuit -> RECOMMENDED | Copilot (both entries) |
| workflow | pre-satisfied or BLOCKED | execute deterministically | Workflow engine |
| external | per-grant | per-grant + approval | MCP / REST / future workers |

## Resolver pipeline (all gates collapse here, one site per concern)

1. Canonicalize operation  2. Resolve strategy + bind  3. Satisfy PRE invariants (probe-first;
read satisfiers auto-run; customer_input -> NEEDS_INPUT)  4. Eligibility gate (mode + tool-gate
+ allowed-actions + contract order)  5. Approval gate (HITL -> AWAITING_APPROVAL)  6. Execute
strategy  7. Verify POST invariants + success vs world-state  8. Audit (single usage-record site).

## CALENDAR — frozen contracts (business-only language)

```
CHECK_AVAILABILITY                                          effect: read
  meaning:  "what real times are open?"        params: window?
  outcome:  the genuinely-open times in the window
  success:  a set of open times (possibly empty) is established for the window   [RUNTIME_VERIFIED]
  invariants:
    - every returned time is genuinely open        MUST   POST  RUNTIME_VERIFIED   (anti-invention)
    - the meeting kind is known (duration/policy)  MUST   PRE   RUNTIME_VERIFIED
  failureModes: no_calendar_available | none_open
  recovery:  may widen the window; may ask the customer's preference
  approval:  none      modes: all execute      (also the satisfier for "availability")

BOOK_MEETING                                                effect: write   assertion: wants one
  meaning:  "the customer wants a confirmed meeting"        params: desired_time, meeting_kind?
  outcome:  "booked for <time>, invite sent to <email>"
  success:  a confirmed meeting exists for this customer at the agreed time AND the invite was sent  [RUNTIME_VERIFIED]
  invariants:
    - no duplicate meeting is created              MUST   PRE+POST  RUNTIME_VERIFIED
    - the customer has agreed to meet              MUST   PRE       RUNTIME_VERIFIED
    - an attendee email is known                   MUST   PRE       RUNTIME_VERIFIED -> else NEEDS_INPUT(email)
    - the chosen time is genuinely open            SHOULD PRE       satisfier: CHECK_AVAILABILITY
    - the meeting kind is known                    MUST   PRE       RUNTIME_VERIFIED
  failureModes: time_taken | no_calendar_available | conflict
  recovery:  bounded retries; may gather alternative times (as data); may ask; escalate last
  approval:  configurable   dedupKey: (customer, meeting_kind, day)   modes: advisory->RECOMMEND

MOVE_MEETING                                                effect: write   assertion: a booking EXISTS
  meaning:  "change the time of my existing meeting"        params: desired_time
  outcome:  "moved to <time>, invite updated"
  success:  the customer's existing meeting now occurs at the new agreed time, still exactly one meeting, parties re-notified  [RUNTIME_VERIFIED]
  invariants:
    - an existing booking is present               MUST   PRE   RUNTIME_VERIFIED  (absent->FAILED nothing_to_move; >1->NEEDS_INPUT which)
    - the new time is genuinely open               SHOULD PRE   satisfier: CHECK_AVAILABILITY
    - exactly one meeting exists afterward          MUST   POST  RUNTIME_VERIFIED  (never duplicates)
    - a new time was provided                      MUST   PRE   RUNTIME_VERIFIED -> else NEEDS_INPUT(time)
  failureModes: time_taken | no_calendar_available
  recovery:  bounded retries; may gather alternatives; may ask; escalate last
  approval:  configurable      modes: advisory->RECOMMEND

CANCEL_MEETING                                              effect: write (destructive)   assertion: a booking EXISTS
  meaning:  "cancel my meeting"
  outcome:  "your meeting on <time> is cancelled"
  success:  the customer has no active meeting for that booking AND parties were notified   [RUNTIME_VERIFIED]
  invariants:
    - an existing booking is present               MUST   PRE   RUNTIME_VERIFIED  (>1->NEEDS_INPUT which)
  failureModes: no_calendar_available
  recovery:  retry on transient failure only; otherwise return FAILED (destructive -> no blind re-attempts)
  approval:  configurable (customer's own demo -> none)    modes: advisory->RECOMMEND
```

## Existing code -> new role

| Existing | New role |
|---|---|
| `objectives.ts` | Business Goal; selects which operation intent applies |
| `capabilities.ts` (`classifyToolEffect`, grouping) | capability registry seed + operation effect |
| `schedule-handler.service.ts` handlers | the CALENDAR provider strategy's fulfillment |
| `connectors/*.adapter.ts`, `listAdapters()` | strategy/provider implementations |
| `needsAvailabilityCheck` / `no_existing_meeting` / `customer_email_required` | calendar invariants, lifted out + made proactive |
| `dispatchToolCall` + orchestrator + `TurnOutcomeLedger` + `evaluatePolicies` | resolver gate/execute/verify/audit stages |
| `routeCopilotTool` | the `advisory` mode policy |
| booking-store (`findActiveBookings`) | the business-state oracle for booking invariants |

## Placement & rules

- Contract/types/registry interfaces -> `packages/shared` (zero execution deps).
- Strategy/provider impls (REST) -> `services/ai`.
- No new microservice (CLAUDE.md sec 1). `NextActionCandidate.tool -> .intent` (coexist; do NOT replace the planner).

## Open sub-questions (resolve during pilot, non-blocking)

1. Multi-tool/strategy partial failure -> reserve a `partial_failure` result shape.
2. `params` typing: runtime passes meaning-values; strategy resolves to concrete.
3. Long-tail custom ops (e.g. `DATABASE.QUERY`) -> decide at CRM/long-tail migration.
4. SHOULD invariant freshness policy (TTL) is runtime-owned; POST verification is the backstop.

## Rollout

CALENDAR pilot -> validate live (no dup events, Hebrew, read provably ran, unsupported
strategy -> BLOCKED not fabricated slot) -> decide by-capability migration vs full cutover
-> CRM -> COMMERCE -> rest. Correctness over speed.
