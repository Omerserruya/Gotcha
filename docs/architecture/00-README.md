# GOTCHA AI Architecture - Implementation Package

Status: **LOCKED - 2026-04-22.** All architectural decisions frozen. No further design discussion.

This directory is the single source of truth for the AI Agent orchestration platform. Engineering implements directly from these files.

## Contents

| File | Scope |
|---|---|
| [`01-final-schema.md`](./01-final-schema.md) | Prisma schema - the entire new + migrated shape |
| [`02-migration-plan.md`](./02-migration-plan.md) | Ordered, downtime-safe rollout plan (8 phases) |
| [`03-execution-engine.md`](./03-execution-engine.md) | `executeAgentTurn` contract, tool dispatch, HITL, routing |
| [`04-service-boundaries.md`](./04-service-boundaries.md) | Service boundaries + interaction diagram |
| [`05-breaking-changes.md`](./05-breaking-changes.md) | Explicit removed / merged / renamed / deprecated list |

## The six pillars (unchanged from locked spec)

1. **One agent config**: `AIAgent` is the only source of truth.
2. **One execution engine**: `executeAgentTurn({ mode: "assist" | "auto" })`.
3. **One HITL evaluator**: `evaluatePolicies()`.
4. **Routing**: first-match-wins over an ordered list; no priority field.
5. **Routines** (née ChatbotFlow): deterministic intake only; four allowed node types.
6. **Behavioral Anchors**: prompt-level guidance, not executable.

## Invariants

- Every tool call goes through `evaluatePolicies()`. No exceptions.
- Every agent turn produces one `AgentTurnLog` row.
- Every conversation is scoped to exactly one tenant. `TenantGuard` enforces at runtime.
- Strictest HITL rule always wins. Catalog is the floor.
- Subs do not call tools and do not route outside themselves.
- Channel interactive UX (buttons, lists) is always Agent-owned via `interactive_reply`.

## Out of scope for this spec

- Long-term agent memory (defer - use "context assembly" language instead)
- Voice Co-Pilot rename (separate PR)
- Cost/budget caps (follow-up)
