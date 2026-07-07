# Reasoner Architecture — ADR (PROPOSED)

> Status: **Proposed 2026-06-30.** Companion to the FROZEN `capability-runtime.md`.
> Decision owner: founder. This ADR challenges and supersedes the *decision role* of
> today's deterministic planner. It does NOT change the Capability Runtime.
>
> One-line: **The Runtime guarantees. The Reasoner judges. A thin deterministic layer
> assembles and validates so the judgment is reliable.** Today's planner is a rule
> engine doing a reasoning model's job; that role is retired.

---

## 0. The reframe: three concerns, not two

The "reasoning above / execution below" split is too coarse and is what traps the
design. The system has **three** concerns:

| Concern | Nature | Owner | Examples |
|---|---|---|---|
| **Guarantee** | deterministic | **Runtime** | correctness, invariants, permissions, billing/credits, approvals, retries, recovery, world-state verification, audit |
| **Judge** | probabilistic | **Reasoner (LLM)** | customer intent, sales/support strategy, which operation, when NO operation, what info is missing, confidence, why |
| **Assemble & validate** | deterministic | **Context/Oracle layer** | world-snapshot, GoalStatus oracle, available-operation menu, output schema/safety gate, conversation-control limits (turn budgets, language, loop-breaking) |

The mistake in "everything above the Runtime is reasoning" is collapsing **Assemble**
into the Reasoner. In 2026 the highest-leverage engineering in an agent is context
engineering + verification — deterministic code that is **not business strategy**.

```
Deterministic Context/Oracle  → assembles world-snapshot, GoalStatus, available ops, validation gate, budgets
        ↓ (structured context)
LLM Reasoner                  → ALL judgment; emits a validated Execution Intent (Operation + meaning params)
        ↓ (validated operation proposal)
Capability Runtime            → guarantees correctness; never decides strategy (per capability-runtime.md)
        ↓ (ExecutionResult)
Writer LLM (separate, no tools)→ language only; cannot take an unsafe action by construction
```

The boundary that matters: **guarantee vs judge vs assemble.** Determinism is not
"2025"; *misplaced* determinism (business judgment in code) is. Determinism around
money, permissions, correctness, and context is timeless — it is exactly what makes a
probabilistic brain safe enough to let reason freely.

---

## 1. Decisions (answers to the nine questions)

1. **Planner-as-decider is retired.** The decision logic dies: objective selection,
   transitions, NBA scoring (`objectives.ts:610-670` magic numbers), keyword
   stage-inference (`objectives.ts:494-508`). A deterministic **Context Assembler +
   Oracle** survives and grows — it is not a planner.
2. **`computeCurrentPlan` is removed.** Its ~40% projection/assembly half
   (`groupToolsIntoCapabilities`, `computeProspectState`, `evaluateGoalStatus`, input
   building) reincarnates as `assembleReasonerContext()`. The decision half is deleted.
3. **`CurrentPlan` becomes the Reasoner's structured OUTPUT**, not computed code.
   Constraints: (a) it is a **validated proposal**, not a command — the deterministic
   gate checks the operation is real/available/well-formed before the Runtime sees it;
   (b) split **reasoning_trace** (audit/eval, untrusted) from **selected_operation**
   (validated, executed); (c) `confidence` is load-bearing (routes to ask/clarify/
   escalate / fallback) but treated as an *ordinal*, calibrated in eval — not a probability.
4. **Objectives become typed business vocabulary**, not an FSM. The `OBJECTIVES` data
   (required-info schemas, `outcome` signatures, `success` predicates) survives as
   vocabulary the Reasoner references and the oracle measures; the chain-walk dies.
5. **Objective chains: split by intent.** *Effectiveness* orderings ("usually qualify
   before pitching") → soft playbook hints the LLM may override. *Permissibility*
   orderings ("may NOT quote before budget qualification") → are NOT prompt guidance;
   they move DOWN into the Runtime as PRE-invariants on the operation. Test: *about
   what works (→ soft, LLM) or about what's allowed (→ hard, Runtime invariant)?*
6. **Yes — deterministic logic genuinely belongs above the Runtime** (the strongest
   correction to the "all reasoning above" framing): context assembly/retrieval; the
   world-state oracle (`GoalStatus`) injected INTO the Reasoner as anti-hallucination
   ground truth; the available-operation menu (reason over a real menu, not imagined);
   output validation/safety gate (valid/known op, params well-formed, confidence floor,
   loop detector); conversation-control policy that isn't an operation (turn budgets,
   "don't send 5 messages in a row," language-match, runaway kill switch).
7. **Risks** (enterprise-weighted): prompt-injection INTO business decisions (a customer
   arguing the bot into a refund) → permissions/approvals/entitlements stay deterministic
   Runtime gates, the LLM only *proposes*; auditability/defensibility (a reasoning trace
   is weaker evidence than a fired rule for regulated tenants); objective thrash without
   `commitObjective` stickiness → persisted reasoning memory as input; silent model drift
   (GPT-5→5.1 changes behavior with zero code change) → the model is now a regression
   surface; regression of the exact bugs the planner fixed (jump-ahead, re-ask,
   passive-close, invented slots) → only safe because Runtime invariants make them
   impossible at execution; latency/cost & runaway loops → hard turn/credit budgets
   (enforced by the billing layer).
8. **Eval framework (non-optional — it is the safety system):** shadow-divergence corpus
   (LLM vs planner) as the golden set; outcome-level eval (was the correct *operation*
   selected / correctly *no-op*?), NOT behavior-matching the old planner; adversarial/
   red-team suite built from the bug classes (injection-to-unauthorized-op, jailbreak,
   thrash, passive-close, invent-slot, re-ask) as permanent CI gates; invariant-attempt
   rate as a tripwire; calibration eval (does confidence track correctness?); per-model
   regression gate (pin model, re-run suite on every model/prompt change before promote);
   online staged rollout shadow → canary-by-tenant/skill → guardrail metrics (escalation,
   approval-override, dup-action, resolution, sentiment) — same shape as
   `BILLING_ENFORCEMENT_MODE = off|observe|soft|hard`.
9. **How frontier labs would build it:** an **agent loop** (model + operations + memory +
   verification), model does the reasoning — they would NOT build a deterministic
   planner. BUT 2026 frontier practice is overwhelmingly context engineering, operation/
   tool interface design, verification, and evals — heavy deterministic scaffolding that
   is not business strategy. They would love the Capability Runtime as the primitive,
   keep entitlements/permissions/billing/approvals as hard deterministic policy (never
   let a model decide *allowed*), use structured-output/tool-use for operation emission,
   and invest enormously in the eval/guardrail layer. They agree the *decider* is the
   LLM; they disagree that *everything above the Runtime is reasoning.*

---

## 2. Self-challenge: what this ADR retracts

The previous analysis recommended **keeping the deterministic planner permanently as a
low-confidence fallback.** Retracted. A permanent dual-brain (LLM reasoner + full shadow
rule engine that must stay in agreement) is a maintenance tax and a consistency hazard
that recreates the very thing we are killing. The deterministic planner is a **migration
scaffold and eval oracle with a scheduled sunset.** Degraded-mode (model outage) collapses
to a *trivial* safe behavior — escalate / "a colleague will follow up" — not a rule engine.

---

## 3. Reasoner output contract (structured)

```jsonc
{
  "business_state": "string — the situation in one line (LLM's read)",
  "goal": "OBJECTIVE_NAME | null — the outcome being driven, from vocabulary",
  "reasoning_trace": "string — UNTRUSTED; for audit + eval only, never executed",
  "missing_information": ["field keys still needed to act"],
  "candidate_operations": [
    { "operation": "BOOK_MEETING", "params": { "...meaning-level..." }, "confidence": 0.0, "why": "..." }
  ],
  "selected_operation": "BOOK_MEETING | NONE",   // NONE = pure conversation this turn
  "confidence": 0.0
}
```

Rules: `selected_operation` must be a member of the deterministic **available-operation
menu** for this turn; params are *meaning-level* (Runtime resolves to concrete). The gate
rejects unknown/unavailable ops and low-confidence emissions → re-ask or fallback. The
Runtime, not the Reasoner, determines success/failure against world-state.

---

## 4. Sequencing — invariants FIRST (the one hard rule)

You cannot hand the brain to an LLM until the guarantees that make a probabilistic decider
acceptable are Runtime-verified invariants. Order:

- **Phase 0 — invariants & operation contracts** (`packages/shared`, zero exec deps):
  define the operation vocabulary + MUST/`success` invariants from `capability-runtime.md`
  (CALENDAR pilot). Add `.intent` beside `.tool` on `NextActionCandidate` (coexist).
- **Phase 1 — Reasoner in shadow** (`observe` mode): run the LLM reasoner alongside
  `computeCurrentPlan`, act on neither, log every `selected_operation` vs `bestNextAction`
  divergence → this log IS the golden eval set + builds the harness.
- **Phase 2 — flip one capability (CALENDAR)** to LLM-decided / Runtime-executed, with the
  deterministic planner as automatic fallback on low confidence / invalid schema. Validate
  live against the pilot criteria (no dup events, read provably ran, unsupported strategy →
  BLOCKED not fabricated slot, language preserved).
- **Phase 3 — demote the objective engine to advisory** (chains → hints, NBA scores deleted,
  `selectActiveObjective` → suggestion). `goal-evaluator` stays as oracle + verifier.
- **Phase 4 — expand operations** (CRM → COMMERCE → rest); retire planner decision-code per
  capability as each migrates; planner sunset once eval gates hold for N weeks.

The Runtime contract (`ExecutionRequest`/`ExecutionResult`, invariants, modes, billing,
approvals, audit) NEVER changes through any phase. The brain swaps; the guarantees hold.

---

## 5. The verdict

**Would we build a deterministic Planner today? No.** We would build a deterministic
**Context/Oracle + Validation** layer (not the same thing), an **LLM Reasoner** as the
decider, and keep the **Capability Runtime** as the guarantee substrate. The future of
GOTCHA is not *less* determinism — it is determinism moved to the three places it is
timeless (money, permissions, correctness, context engineering) so the probabilistic brain
is finally safe enough to let reason freely.
