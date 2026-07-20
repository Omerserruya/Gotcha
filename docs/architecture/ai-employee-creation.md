# AI employee creation — one wizard, two surfaces

Written 2026-07-20. Replaces the situation where onboarding and AI Studio each
had their own creation flow.

---

## 1. What changed

There used to be **two implementations**: AI Studio's `AgentBuilder` (server-
owned draft via `/api/ai-agents/builder/*`) and onboarding's bespoke
Meet/Tune screens (persona chat, employee generated server-side at
`/api/onboarding/complete`). Different UIs, different draft stores, different
creation servers — and different resulting employees.

Now there is **one component**:

```
frontend/src/components/aiEmployee/AgentBuilder.tsx
   ├── /ai-studio/agents/new           (full-screen)
   └── /setup  Movement 8              (embedded)
```

Onboarding supplies only the surrounding navigation. It passes:

- `embedded` — drops the wizard's `fixed inset-0` chrome so it sits inside the
  movement flow;
- `onDone` — the host advances its own movement instead of the wizard pushing
  to the editor.

The creation **logic** is identical either way. That is the point of sharing
the component rather than forking it.

## 2. Same backend model

Both paths converge on the same `AIAgent` shape:

- `services/ai/src/services/ai-agent-defaults.ts` is the single definition of
  creation defaults. Onboarding's generator previously set only
  model/provider/temperature/maxTokens, so an onboarding-hired employee
  silently differed on `avatarColor`, `tone`, `languages`,
  `escalationMessage`, `confidenceThreshold` and both autonomy caps — i.e. on
  **when it escalates and how long it may run unattended**.
- Identity-bearing fields (name, role, goal, persona, status) are deliberately
  *not* in the defaults block; those are decisions each flow makes explicitly.

## 3. Adopt-or-generate

The wizard creates the employee up front on `/builder/start` as
`status=DRAFT, builderStep!=null`.

So `/api/onboarding/complete` → `hireRecommendedEmployee` must **adopt** it:

```
find most-recent AIAgent where status=DRAFT and builderStep is not null
  ├── found  → adopt: clear builderStep, flip ACTIVE, return early
  └── none   → generate (the pre-existing path, for owners who skipped)
```

Without this the tenant finishes onboarding with **two** employees — the one
they configured by hand and a machine-generated twin — and their choices look
ignored.

The early `return` on the adopt branch matters too: recommendation values
(name/role/persona) are **defaults for the generated path, not corrections to a
deliberate choice**. A live test proved a draft named "Owner Chosen Name"
survives a recommendation carrying "Recommended Name".

## 4. The gate that bit us twice

`ai-agent-builder.ts` gated its whole router on `requireActiveTenant()`. Since
onboarding tenants are `PENDING_ONBOARDING`, embedding the wizard produced a
screen that rendered correctly and **403'd on every call** — the same class of
bug as the OAuth connectors (see
[integration-connection-lifecycle.md](./integration-connection-lifecycle.md)).

Building the first employee *is* an onboarding activity. The router now uses
`requireOnboardingOrActiveTenant()`.

> Worth internalising: this was caught only by driving a real browser against a
> real `PENDING_ONBOARDING` tenant. Typechecks and unit tests were green.

## 5. Testing

- `services/auth/src/__tests__/onboarding-adopt-employee.test.ts` (6) — the
  decision table, including an abandoned older draft, a stray `DRAFT` with no
  `builderStep`, and a draft competing with an unrelated `ACTIVE` employee.
- `services/ai/src/__tests__/ai-agent-defaults.test.ts` (3) — the shared
  defaults block, and that it carries no identity-bearing fields.

**Live-verified**: a seeded `PENDING_ONBOARDING` tenant holding a wizard-style
draft, completed through the real endpoint, yielded **exactly one** agent —
adopted, activated, `builderStep` cleared, name preserved.

**Not verified**: building an employee through the wizard's LLM chat all the
way to Finish.
