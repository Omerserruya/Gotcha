# Reply engine v2

Spec: the brief of 2026-11-16 (digest: release-next-kit/reply-engine-v2/PROPOSAL.md). Types: `services/ai/src/services/reply-engine/contract.ts`.

## Goal
One end-to-end agent per business. It thinks like an employee and always sees every tool it is allowed. Targets: p50 under 5s for a turn with no tools, under 10s for a store-search turn (prod baseline 20.6s).

## The turn
1. **Gate 1, code: should we reply at all?** It reuses the existing predicates. The worker already handles owner-recent, assigned or handed-over, business hours, the autonomy budget and a request for a person. In the AI service, v2 re-checks that the agent is ACTIVE, checks credits (`checkAiAllowed`) and checks the cost budget (`createTurnBudget().preflight`). A blocked turn returns the same result shapes as today (`billing_blocked:*`, an escalation).
2. **One parallel load.** This loads:
   - the ConversationState row for the lane;
   - the customer card;
   - the business profile and the platform and business rules;
   - the skills list (role skill plus BusinessSkill/AgentSkill);
   - the tool surface;
   - the last N messages.
3. **The prompt.**
   - A stable prefix holds the role, the business, the voice, the platform and business rules, the skills list and the tools. Tools are sorted by name with short descriptions, so the provider caches the prefix.
   - A small turn part holds the state, the rolling summary and the last N messages.
   - The target is about 6k input tokens.
4. **One model call, plus tool rounds.**
   - The model is gpt-6-luna through `generateResponse`, so the model layer handles the developer role, /responses for tools plus effort, usage logging and metering.
   - Tool choice is `required`. The model either calls tools or ends with `respond {reply, state_update, claims, handoff?, cards?}`.
   - `read_skill {name}` returns a skill's full playbook.
5. **Gate 2, code, before each tool.**
   - Live turns: `ActionOrchestrator.submit` covers `evaluatePolicies` with aiAgentId, HITL approval, the idempotency ledger and `skillApprovalReason` as tightenApproval. Business policy covers refund and coupon caps.
   - Shadow turns: `evaluatePolicies` only. Reads run for real. A write and an approval are simulated, so no approval request or tool_execution_request is written.
6. **Tools run in parallel, each with its own timeout** (`REPLY_ENGINE_TOOL_TIMEOUT_MS`, default 8s). A timed-out tool returns `{ok:false, reason:"timeout"}` to the model. When tools run past `REPLY_ENGINE_INTERIM_AFTER_MS` (default 3s), the turn carries a short "checking" interim message.
7. **Gate 3, code, before send.** It checks the model's claims and reply against this turn's tool results, the state and the knowledge used:
   - prices only from tools (`ungroundedPrices`);
   - ACTION-HONESTY (`validateActionHonesty`);
   - products named only if a tool returned them or the state offered them;
   - neutral Hebrew address and no em or en dashes.
   On a problem there is ONE targeted rewrite with the problems listed. If that fails, a safe fixed reply goes out. This replaces the regen chain. Card-digit masking (`guardCardDetails`) still wraps the result.
8. **Save.** The state update is merged and saved to the lane's row. The `ai.bot_turn` audit row keeps a compatible shape, with `engine:"v2"`, stageMs and tokens. When the window has slid past older messages, the rolling summary is refreshed after the reply, off the critical path.

## ConversationState
Table `conversation_states`, unique on (conversation_id, lane). It replaces, for v2, the funnel stage, behavior state, objectives, contract progress, skill run, flow controller, discovery and session facts.
- Fields: stage, intent, facts, offered_items, pending, active_skill, summary, summary_up_to and turn_count.
- Migration: `packages/shared/prisma/migrations/20261116120000_conversation_states` (additive). It is applied by the Supervisor, not by the engine.

## The switch
- `REPLY_ENGINE_MODE` = off | shadow | autonomous, with `REPLY_ENGINE_TENANTS` (comma list, or `*`). These sit on the same ladder as `agent-loop/flags.ts`.
- Rollback: set the mode to off and recreate ai.
- Autonomous: v2 drives the turn. On a v2 error the legacy path answers that turn, until legacy deletion.
- Shadow: the legacy path answers. v2 runs fire-and-forget on lane "shadow" inside `platformPaidScope`, so every call is logged with billedTo platform and nothing is debited from the tenant. The outcome goes to audit `ai.reply_engine_shadow`.

## Tool surface
Every tool the employee is allowed is always exposed. That is `buildAgentToolsForAIAgent` plus the custom tools, minus whatever `evaluatePolicies` (with aiAgentId) DENIES, plus `read_skill` and `respond`. Nothing is hidden by stage. If a tenant nears the 128-tool cap, the answer is to merge tools per system, never to hide them by stage.

## Legacy deletion (after v2 is stable)
Delete:
- the inner pipeline of `ai-bot.service.ts`;
- the blocks of `prompt-builder.service.ts`;
- `behavior-engine.service.ts`;
- `objectives.ts`;
- the regen chain of `reply-style-check.service.ts`;
- the flow controller;
- the `agent-loop` routing.

The checklist is kept in this doc. It ends with a grep showing nothing references the old path.
