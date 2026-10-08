# AI Studio: Skills and Automations - mapping, decisions and work plan

Status: living document. Owner: rebrand supervisor session. Last update: 2026-10-06 (Phase 1 backend built).
Design source: `/home/ocs/projects/redesign/design/Redesigning GOTCHA from scratch 6/GOTCHA Directions.dc.html`
(frames 00d-00h, 07, 07f, 07g, 09, 09b, 09c, 09d, 09e, 13g-13j, 21). Extracted spec: `/tmp/claude-1000/design6/SPEC.md` (local).

Classification legend: **works** (exists and works) / **partial** / **adapt** (exists, needs adaptation) / **missing** / **check** (needs more checking).

---

## 1. Product concept (from Omer, 2026-10-06)

- **Automation** = an explicit flow: trigger, conditions, nodes. Runs the same way every time and does not depend on the AI deciding to run it. It may hand control to an AI employee or run a skill; it must be clear who owns the conversation at every point.
- **Skill** = guidance for an AI employee for a specific business case: when it applies, what to gather, the steps, the tools, completion and escalation. Business-specific, created by the tenant, attached to employees from the employee editor. Not necessarily a node graph and not just prompt text.
- **AI employee layers** (product view, not one entity each): role, language, brand voice, goal, stage/progress, allowed tools, system skill / ROLE, attached business skills, knowledge.

---

## 2. Mapping of the existing system

### 2.1 AI employee model
| Capability | Where | Status |
|---|---|---|
| Role (selects the built-in methodology and the objective chain) | `AIAgent.role`, `packages/shared/prisma/schema.prisma:1220` | works |
| Goal | `AIAgent.goal` rendered in `# Goals`, `services/ai/src/services/prompt-builder.service.ts:1071` | works |
| Brand voice | `persona.brand_archetype` -> `renderBrandVoice`, `services/ai/src/services/brand-archetypes.ts:142` | works |
| Per-agent tone fields | `tone/style/toneConfig/behavioral` (schema:1230-1253) | not used (tone comes from `personality.md`) |
| Languages | `AIAgent.languages` (schema:1231) | partial: stored, ignored by the live reply path |
| Hebrew style file | `prompt-builder:639-668` needs `ctx.locale === "he"`, never set on the autonomous path (`ai-bot:1549-1598`) | check, likely broken |
| systemPrompt | `AIAgent.systemPrompt` (schema:1238) never reaches a model (`ai-bot:376-396`) | dead, do not build on it |
| Author steps / when-then rules / escalation | `conversationFlow`, `behavioralAnchors`, `escalationRules` -> `# Agent Playbook Anchors` (`prompt-builder:1335-1468`) | works, static, always injected |
| Allowed tools | `AgentToolPermission` (schema:2353) `isAllowed`, `usageRule`; `requireApproval` is inert per agent | works / partial |
| Knowledge | `AIAgentKnowledge` (schema:1334), `knowledge.service.ts:29-60` | works |

### 2.2 Per-turn loop (live path is `services/ai/src/services/ai-bot.service.ts`, `AGENT_LOOP_MODE` defaults to off)
- Trigger: `services/incoming-worker/src/workers/incoming.worker.ts:742-754` -> `processAIBot` (`incoming-worker/src/services/ai-bot.service.ts:75-358`) -> `POST /api/ai-bot/reply` -> `generateAIBotReply` (`ai-bot:975`).
- Context assembly order and prompt layers: `ai-bot:1199-1619`, `buildAgentPrompt` (`prompt-builder:385-438`). Stated priority: Safety > Execution Contract > Strategy > Brand Voice > Relationship > Playbooks > Style (`prompt-builder:721-723`).
- Tools: built-in + custom + adapter tools filtered by `AgentToolPermission` and capability (`ai-bot:1996-2375`). Execution through `ActionOrchestrator` (`services/ai/src/services/orchestrator/action-orchestrator.ts:94-641`) with `evaluatePolicies` DENY / REQUIRE_APPROVAL / ALLOW and `ToolExecutionRequest` rows.
- Coalescing: a fast second message aborts the in-flight turn and replaces it.
- Status: **works**.

### 2.3 Built-in "Skill" (code) and objectives
- `services/ai/src/services/skills.ts`: 6 structured Skills (mission, objective, flow, success/failure, `requiredKnowledge[]` with priority), selected by role only (`ROLE_TO_SKILL`, `selectSkill`). Rendered as BLOCK 1.
- Knowledge Ledger (`knowledge-ledger.ts`): deterministic gap check of `requiredKnowledge` against CRM, memory, facts. Live extraction merges `requiredKnowledge` (`intelligence-live/subscriber.ts`).
- Objective engine (`objectives.ts`): fixed objectives with required info + completion tool; active objective = first incomplete; `ActiveGoalSnapshot` committed per turn and persisted in `AuditLog ai.bot_turn.metadata.activeGoal`, reloaded per customer for 14 days (`plan-context.service.ts:84-130`). Called from the planner and from about 3 more orchestrator sites (gates ~2706/2923, persistence ~3134).
- Goal status (`goal-evaluator.ts`): a projection ACHIEVED / FAILED / BLOCKED / ACTIVE, not a state machine.
- Unused: `AISkill` registry (`packages/shared/src/schemas/ai-worker.ts:26-49`) behind `USE_UNIFIED_WORKER`, no live caller.
- Status: built-in skill **works** but is platform code, one per role; a tenant-defined, per-employee, relevance-selected skill is **missing**.

### 2.4 Stage / funnel
- `TenantFunnel` stages JSON per department or agent (schema:5178), stage `copilot` {goal, requiredQuestions, requiredDataFields, exitCriteria}; resolved from the CRM stage cache (`stage-resolver.service.ts:48-124`); rendered as `# Pipeline Stage`; `StageTransition` rows written only by manual/CRM/voice paths. The chat bot never advances the stage.
- Status: **partial** (read-only in chat).

### 2.5 Process-like entities
- No tenant Process entity. "Processes" in the old UI = automation graphs (`FlowCanvas` + `ChatbotFlow`).
- `ActionContract` + `ActionContractProgress` (schema:5280-5334): tenant-wide required-tool sequences with per-conversation progress and pause-on-approval; dispatch gates are disabled stubs (`ai-bot:2965-2969`). Status: **adapt** (good model for skill progress, not reused directly).

### 2.6 Handover and HITL
- Escalation: `escalateToHuman` (`incoming-worker ai-bot.service.ts:859-990`), `recordHandover`, `ConversationHandover`. Approval pause: `handledBy=awaiting_approval`, resume via `runApprovedAction` + `sendApprovalContinuation` + `restoreAiOwnership` (`services/conversation/src/routes/approvals.ts:437-830`). HITL policy lives in `tool-gate.ts` at tenant level.
- Status: **works**. Resuming a specific skill step: **missing**.

### 2.7 Automations
| Capability | Where | Status |
|---|---|---|
| Graph store | `FlowCanvas` (one per tenant, always live, no validation), `ChatbotFlow` (sub-flows, `isActive`, free-text `trigger`, `runCount`) | adapt |
| Runtime | `incoming-worker/src/services/flow-executor.service.ts` walker (MAX_STEPS 50), `flow-resume` queue, voice runtime `services/ai/src/services/voice-flow/voice-flow-runner.ts`, comment walker | works with bugs |
| Triggers | inbound first message only (`incoming.worker.ts:728`), keyword/campaign (first message only), comment, webhook (`POST /webhooks/:token`), voice call events (separate runtime), scheduled message kick | partial; schedule/tag/order/conversation events missing |
| Conditions | keyword, channel, regex work; tag, intent, sentiment, time, attribute always false | partial |
| Send nodes | text, image/file (native on WA/Messenger/IG/Slack), quick reply (buttons), template (WA) | works; list missing, interactive is text+link |
| Do nodes | set variable, http request, update contact tag/attribute, route to agent / sub-flow / department, end (close / handoff / wait) | works; assign to a person, create task, notify, run skill missing; `ai_generate` is a stub |
| Validation | `services/chatbot/src/lib/graph-validator.ts` only on `/activate`; bypassed by PUT/POST `isActive` | partial |
| Run history | none (`runCount` only) | missing |
| Dedupe / loops | non-atomic inbound dedupe, webhook retries resend, voice in-process map | missing |
| Known bugs | sub-flow resume on inbound restarts main canvas (`incoming.worker.ts:787-799`); wait + inbound runs twice (`flow-executor:163-166`); flow-resume does not re-check the cursor | bug |
| v2 | `studio/automations` reads `ChatbotFlow` only, create/edit/activate not wired | partial |

### 2.8 Logs
- `AuditLog` `ai.tool_call.*`, `ai.bot_turn` (behaviorState, activeGoal, toolCalls), `ai.paused_for_approval`, `ToolExecutionRequest`, `ApprovalRequest`, `ConversationHandover`. No record of which skill was selected (missing). No flow run log (missing).

---

## 3. Decisions

### 3.1 Skill representation
- **New tenant entity `BusinessSkill`** (UI name: Skill). The built-in role `Skill` in `skills.ts` stays as the **ROLE / system skill** base layer and is not stored as a record. Reason: it is platform methodology tied to the objective chain; making it editable would break the chain and the cache-stable prompt prefix.
- Fields (from 09/09b/21): `name`, `situation` (customer words), `category` (orders/products/bookings/other), `whenToUse`, `examples[]`, `exclusions[] {text, skillId?}`, `steps[] {id, kind: find|check|change|document|message|approval|handover, title, guidance, tools[] (tool names), approvalOverAmount?, elseNote?}`, `rules[] {type: never|handover, text}`, `requiredInfo[] {key, label, priority}` (derived from steps, editable), `status: draft|active|archived`, `version`, audit fields. Tenant-scoped.
- **Assignment `AgentSkill`** `{aiAgentId, skillId, mode: on|watch|off, order}`. New skills default to `watch`. Employee fallback when no skill fits: `AIAgent.noSkillPolicy: answer_from_knowledge | always_handover | knowledge_only` (default `answer_from_knowledge`, which is today's behaviour).
- **Run record `SkillRun`** `{conversationId, aiAgentId, skillId, skillVersion, mode, status: active|completed|handed_over|failed|abandoned, currentStepId, gatheredKeys[], stopReason, trace[] (step, tool, outcome, at), startedAt, endedAt}`. Gives continuity across turns, stats (runs, alone %, asked you, stop reasons) and the run log.

### 3.2 Skill in the loop (no parallel engine)
1. **Selection** inside the existing per-turn judgement call in `plan-context.service.ts` (the one that already resolves `requiredKnowledge`): input = the employee's skills in `on` and `watch` mode (name, whenToUse, examples, exclusions) + the open `SkillRun`; output = `{matchedSkillId | null, gatheredKeys}`. No extra LLM call.
2. **Stickiness**: an open `SkillRun` stays active until completed / handed over / the customer clearly changes topic (the judgement returns another skill or none for two turns). Changing topic closes the run as `abandoned` with reason.
3. **Conflicts**: several candidates -> the employee's `order`; `exclusions` route to the named skill; skill `rules` override skill steps; platform guardrails, tool gate and HITL override everything.
4. **Injection**: only the active skill renders, as a per-turn block `# Active Skill` next to `# Pipeline Stage` / `# Current Plan` (steps with the current one marked, rules, required info status). BLOCK 2 lists the employee's skill names only, so the cached prefix stays stable.
5. **Objective / ledger**: the active skill's `requiredInfo` is merged into the ledger's required keys (same path as the built-in skill), so "what to gather" uses the existing gap check and live extraction. Skill completion = its last step's tool succeeded or the `document` step done; recorded on `SkillRun` and fed to goal status.
6. **Watch mode**: the skill is selected and a `SkillRun(mode=watch)` records what it would do, but the block is not injected. No customer-facing effect.
7. **Tools and permissions**: a skill never grants a tool. A step's tools are checked against the employee's allowed tools and connected capabilities; a missing or blocked tool makes that step a hand-over point. `approvalOverAmount` can only tighten: it adds a REQUIRE_APPROVAL condition in `evaluatePolicies` for that tool while the skill is active.
8. **Proposed vs pending vs done**: taken from `ToolExecutionRequest` status (proposed / approved / completed / failed / denied); the skill block tells the model which state each step is in, and the reply rules forbid claiming an action that is not `completed`.
9. **Resume**: after approval or after the customer supplies missing info, the next turn reloads the open `SkillRun` and continues from `currentStepId`.
10. **Skill changed or removed mid-conversation**: `SkillRun` pins `skillVersion`; an edit applies from the next run; removal or `off` closes open runs as `abandoned` (reason `skill_removed`) and the employee falls back to `noSkillPolicy`.
11. **Logging**: `ai.skill_selected`, `ai.skill_step`, `ai.skill_completed`, `ai.skill_handed_over` audit rows + `activeSkillId` in `ai.bot_turn` metadata. No model reasoning stored.

### 3.3 Automations
- Keep the existing runtime (flow-executor walker + flow-resume queue). Each automation = one `ChatbotFlow` with a **structured trigger** (`triggerType`, `triggerConfig`) replacing the free-text one (old text kept as `description`). `FlowCanvas` (main playbook) stays as the routing graph and is shown read-only until migrated.
- **Run log**: new `AutomationRun {flowId, triggerType, eventKey, conversationId?, status, startedAt, endedAt, error}` + `AutomationRunStep {runId, nodeId, nodeType, status, output, at}`. `eventKey` unique per flow = dedupe (one run per event). Loop guard: events caused by an automation do not trigger automations; max N runs per conversation per minute.
- **Trigger dispatcher** (one place, incoming-worker): message received (every inbound, not only the first; keyword optional), new customer (first message), call missed / call answered (from the existing voice events, executed by the flow walker with the customer's real channel), tag added, webhook (exists), schedule (cron in the existing scheduled worker). Order event, cart, form, story mention: drawn as unavailable with the reason until a source exists.
- **Coordination with the AI**: on an inbound, matching message automations run first. If an automation performed a Send node or set `handledBy=flow`, the AI does not answer that inbound (one responder per inbound). Otherwise the AI runs as today. "Hand to AI employee" and "Run a skill" set `assignedAiAgentId` (+ open a `SkillRun` for run-a-skill) and `handledBy=ai_agent`, ending the automation's ownership.
- **Nodes to add / fix**: list message (WA), real buttons where the channel supports them, wait for reply with timeout branch, opening hours / language / segment / A-B / split by channel conditions, assign to a person, create task, notify team, close conversation, update customer field, run a skill. Fix: sub-flow resume, wait race, activate bypass, send failure handling (mark run failed + optional orphan handoff). Unavailable nodes (Sheets, rating, location, SMS) are listed dimmed with the reason.
- **Validation** on every activate path (PUT/POST included), per-channel limits (3 buttons on WA, template outside 24h).
- Versioned draft/publish and node-by-node test run: phase 3.

### 3.4 Onboarding 00d-00h
- UI skeleton per design, wired to what exists (workspace scan, ingest status, business facts, business core connect, try-it via Copilot/compose). No new backend (Omer: "only a skeleton, I'll edit more").

### 3.5 Web chat settings 13g-13j
- Frontend over the existing `GET/PUT /api/channels/webchat/:id/settings` + embed snippet. Settings the backend does not store are drawn with the reason.

---

## 4. Work plan (dependency order)

| Phase | Backend | Frontend |
|---|---|---|
| **1. Skills core** | migration (`BusinessSkill`, `AgentSkill`, `SkillRun`, `AIAgent.noSkillPolicy`); CRUD + assign routes; permission-fit check route; selection in plan-context; `# Active Skill` block; ledger merge; SkillRun lifecycle; audit events; stats route | Studio nav "Skills"; 09 library; 09b editor (when, examples, not for, steps with tools, rules, used by); 21 new skill (describe -> draft); 07g employee skills tab (order, mode, fallback, add with fit check) |
| **2. Automations core** | migration (`triggerType/Config`, `AutomationRun(+Step)`); dispatcher with dedupe + loop guard; runtime bug fixes; new nodes; validation on all paths; AI coordination rule; run log routes | 09c list (trigger, flow path, runs, last run, toggle); 09d builder (library, canvas, inspector); 09e add-step sheet with availability; run log |
| **3. Depth** | skill sandbox test on a past conversation; backtest; templates; missing-skill suggestions from unhandled clusters; automation versioned publish + test run; web chat 13h/13i gaps (employee per widget via the canvas, WhatsApp hand-off, logo upload, one-line snippet); call triggers from voice events | 09b live test panel, 21 backtest, templates, suggestions |
| **4. Onboarding + web chat** | none new | 00d-00h skeleton, 13g-13j |
| **Fixes found** | `languages` unused, Hebrew style file never loads, chat bot never advances stage (document only) | - |

Rules for every phase: dev only, no push, tests through the real router, tenant guard + `requireVisibleConversation` on every conversation route, no em-dashes.

---

## 5. Test scenarios (acceptance)

Status 2026-10-06: 1-3, 5, 7-10 passed; 4 blocked on a test store; 6 passed at test level only.

1. Create a skill, save, edit, attach to an employee. **Passed** (supervisor, through the UI on dev: create, edit, attach, detach, archive). Routes: `business-skills-routes.test.ts`.
2. Skill used in a conversation and continued after another message. **Passed live** (Phase 1 test chat, Maya; sticky run across turns, 9edb32a9). Test: `skill-runtime.test.ts` (sticky / one missed turn / topic change).
3. Delivery status scenario. **Passed live** (Phase 1 test chat: get_order, completed).
4. Product exchange scenario, with the tools available. **Blocked**: needs a store with an exchange tool (Shopify is in ERROR on dev; WooCommerce has no exchange tool). Not simulated on purpose. Up to there it passes live: order found, stock checked, hand-over at swap.
5. Missing or blocked tool -> hand-over at that step. **Passed live** (Exchange hands over at `swap`; re-run with the skill on and the wording fix, b0f807ba). Fit check reports `handsOverAtStep: swap`.
6. Tool failure and human approval -> resume. **Passed at test level only**: `skill-approval-resume.test.ts` (69be34d8) and `skill-prompt-and-approval.test.ts` (the orchestrator tightens ALLOW to an approval). Not live: the only amount-gated step is the unavailable swap.
7. Automation fired by a real event. **Passed live** (Phase 2: inbound message, tag added by a person through the gateway, schedule and webhook in tests; e39816e5, 19d68e8d).
8. No double reply / double action (dedupe, one responder per inbound). **Passed live** (same message twice and same tag event twice = one run; loop guard 5/minute; automation answered = 0 AI turns; nothing runs while a person owns the conversation).
9. Permissions and tenant isolation. **Passed live** (56537f4f): another tenant's admin gets 404 on automation routes and 402 (plan gate, reveals nothing) on skill routes, whose cross-tenant 404 is covered by router tests; a plain agent gets 403 on every skill and automation write.
10. Existing behaviour unchanged when no skills are attached. **Passed** (test: the prompt is byte-identical without skills, `skill-prompt-and-approval.test.ts`; the wizard judgement call is unchanged without skills).

## 6. Assumptions log
- ROLE / system skill = the existing code layer, not a record (see 3.1).
- New skills start in watch mode (design 09/21).
- "Asks you over X" on a step only tightens approval, never loosens.
- Order event, cart, form and story triggers are shown unavailable until an event source exists.
- `FlowCanvas` (main playbook) is not migrated in this round.
- (Phase 1, backend) Only `active` skills run in the loop; a `draft` does not run, not even in watch. Publishing = PUT `status: "active"`.
- (Phase 1) `version` increments on every PUT. A run follows ONE definition: no old definitions are stored, so editing a skill ends its open runs as `abandoned` (`skill_changed`) and the new version starts fresh if it still fits ("an edit applies from the next run").
- (Phase 1) Selection rides the wizard-binding judgement call. An employee with skills but no wizard config now makes that call (the only added cost); with no skills the call and its prompt are byte-identical.
- (Phase 1) A skill that finished in a conversation is not restarted there for 5 minutes (live check: a "thanks" restarted it). The employee still answers; it only does not open a duplicate run.
- (Phase 1) While a live (`on`) skill owns the turn, `# Current Plan` renders paused (its drive stands aside, the tool list stays) and the objective-driven forcing, recovery and passive-close backstop are gated. The objective snapshot still persists, so the chain resumes after the skill ends.
- (Phase 1) Step state = the run's own trace (each turn's tool calls from the bot log, including results reused from the idempotency window and sandbox simulations) merged with `ToolExecutionRequest` rows timed by their latest event. Request rows alone missed reused results.
- (Phase 1) `askedYou` = runs that ended `handed_over` or whose trace has an approval request. Skill stats exclude sandbox (test chat) runs; the run log lists them.
- (Phase 1) `noSkillPolicy` is set through `PATCH /api/ai-agents/:id` (there is no PUT on that route).
- (Phase 1) `requiredInfo` is sent by the editor, not derived from the steps by the backend.
- (Phase 1 follow-up) A hand-over turn must not offer or ask to do the next step (live check: "shall I go ahead with the exchange?" in the hand-over message). The `# Active Skill` block says so on a step the employee cannot do, and every active block carries the general rule. A prompt rule, not a reply filter.
- (Phase 1 follow-up) Tool labels come from one place (`services/ai/src/services/tool-labels.service.ts`): `provider` (slug, for the logo), `providerLabel` (the integration catalog's name, so "WooCommerce", not a case-folded slug), `actionLabel` (shared `toolDisplayName`, sentence case; GOTCHA's own tools translated with `?locale=he`). `/tools`, the fit check and every skill response (`steps[].toolDetails`, read-only) use it.
- (Phase 2) An automation is a `ChatbotFlow` with `triggerType`; a flow without one is a playbook sub-flow and is never fired by events. Routes `/api/automations` (chatbot service); `/api/chatbot-flows` answers 409 for an automation and no longer takes `isActive` past validation.
- (Phase 2) Runs ride the existing walker (`executeSubFlow` / `executeWebhookFlow` with a run context), not a new engine. `automation-runner.service` (incoming-worker) is the one place a run starts, resumes and ends.
- (Phase 2) Dedupe = unique `(flowId, eventKey)`: `msg:<messageId>`, `tag:<contact>:<tag>:<ms>`, `sched:<local date>T<HH:mm>`, `hook:<jobId>`. Loop guard: 5 runs per conversation per minute, and an automation's own writes (add_tag) emit no events.
- (Phase 2) One responder per inbound: automations run first; the first run that answered (a delivered send, a park for a reply, a hand-on) ends dispatch and the AI does not answer that message. A run that only did internal work did not answer. Automations never run while a person owns the conversation, and nothing new starts while a run is parked there.
- (Phase 2) A run that parks for a reply claims the conversation (`handledBy: flow`) and restores the previous owner when it ends; a timed Wait does not claim (the owner keeps answering, only the timer moves the run). A failed run leaves an unowned conversation with the team (WAITING).
- (Phase 2) Routing: when automations answered the first messages of an unowned conversation, the first message none answered is the one the playbook routes (before, only message #1 was ever routed).
- (Phase 2) Fixed on the way: a parked sub-flow resumed the main canvas; an inbound on a timed Wait walked past it and the timer ran it again; flow-resume timers did not check the cursor.
- (Phase 2) Create task = a task on the customer's CRM record (the post-conversation kind-aware path, via an internal ai route); no CRM link is a failed step with the reason. Notify team = in-app to the chosen people / department / admins (direct-addressed, not a preference event).
- (Phase 2) Call missed / call answered are listed but not wired to voice events yet (Phase 3); order, cart, form and story mention have no event source.
- (Phase 3, web chat) The employee per widget must be set in the playbook canvas (`channel_entry` per connection → `route_target`): live routing is `executeMainFlow`, and RouterRule rows do not decide who answers, so an upsert there would be a second source of truth. `whatsappHandoff` in `webchatSettings` needs an auth rebuild. There is no logo/cover upload route (the only upload is inbox media, bound to a conversation); it stays an https URL. The one-line snippet (v1.js data-store) differs from today's loader.
- (Acceptance, 2026-10-06) 4 (exchange with the tools available) is BLOCKED on a store with an exchange tool: Shopify is in ERROR on dev and WooCommerce has no exchange tool. Simulating a disconnected integration in the test chat would show a path that cannot run, so it is not done. Needs a Shopify test store.
- (Acceptance) 6 (approval, then resume at that step) is shown at the runtime level (`skill-approval-resume.test.ts`: ask, pending, approved later, completes at that step with nothing redone; rejected stays at the step). Not live: the Exchange skill's only amount-gated step is the unavailable swap.
- (Acceptance) 9 live through the gateway: another dev tenant's ADMIN gets 404 on `/api/automations/:id`, `/runs/:runId`, `/:id/runs` and DELETE. On the ai routes (business-skills, ai-agents/:id/skills) it gets 402 `TENANT_PLAN_REQUIRED` first, because no other dev tenant has an active plan; nothing about our records is revealed, and the cross-tenant 404 on those routes is covered by router tests. A dev-tenant AGENT gets 403 on every skill and automation write (`ai:employees:update`, `ai:workflows:update`, `ai:workflows:publish`).
- (Known) Reads differ by design for now: automation reads need only membership (like `/api/chatbot-flows`), skill reads need `ai:employees:read` (an AGENT gets 403). Decide whether automation reads should need `ai:workflows:read`.
- (Known, unrelated) `services/ai/src/__tests__/action-executor.test.ts` has 3 failures at HEAD: its shared mock has no `getPolicy`, and the real one opens Prisma.
- (Phase 1 follow-up) Live re-run with Exchange "on" in the test chat: the employee offered to confirm the exchange two turns before the step it cannot do, and asked for an address on the hand-over turn. Fixed (b0f807ba): the block names the steps it cannot do up front, and the hand-over rule forbids asking for anything. A simulated escalation in the test chat no longer shows the silent-turn fallback.
- (Known) The knowledge-retrieval classifier (`isSemanticallyRetrievable`, behavior-engine) is not Hebrew-aware: its prefix patterns end in `\b`, which in JS only works for ASCII, so Hebrew courtesy phrases of 8+ characters ("תודה רבה") pass as questions. Not changed: making its prefixes Hebrew-aware would also skip retrieval for real questions that start with a listed word ("לא קיבלתי את ההזמנה"). Gap recording has its own whole-message courtesy check instead (47830c87).
- (Known, Phase 3) `UnansweredQuestion` has no conversation id (tenant + cluster only), so the list cannot be filtered by conversation (sandbox, department visibility) at read time; test-chat exclusion is at write time. Linking rows to conversations needs a migration.
- (Omer, 2026-10-07) Reading automations needs `ai:workflows:read`, like skills need `ai:employees:read`. Owner and admin have it by default; department manager and agent do not (no role default changed). The legacy `/api/chatbot-flows` is unchanged (membership only): the old app still uses it (ai-studio page, bot page, MainPlaybookEditor) and so does the ai tool registry; it already answers 409 for an automation.
- (Omer, 2026-10-07; billing) AI credits reset every month on every plan (f4640220). `BillingInterval.ANNUAL` exists only in the schema (no code path reads it); the stuck wallet came from a billing period longer than a month (dev: a MONTHLY subscription hand-set to one year), because renewal was the only place the allowance was granted. Each billing tick now grants the current credit month (counted from the period's anchor day), expires the previous month's included remainder, once per tenant per month. Purchased and PROMO credits are untouched: the dev PROMO lot (2,000 granted, 1,964.9 left) survives every reset. Live on dev after the rebuild: 7,000 included for 2026-09 (until 8 Oct 14:19), a second run granted nothing. Open: if an annual plan is ever sold, renewal still computes a one-month period and would charge monthly; charging by interval is a separate change.
- (Onboarding gate, 2026-10-07) Core systems (the activation event) now include the stores WooCommerce and Wix beside the CRMs and Shopify; the list lives in ONE place (`services/auth/src/services/onboarding-state.service.ts`, onboarding.ts imports it). WooCommerce also gets a "Connect" recommendation. Wix does not: its adapter reads orders, products and contacts, but there is no Wix catalog row and no Wix app configuration, so its connect flow cannot complete (the callback answers `wix_catalog_missing`); a connected Wix would still count as the core system.
- (Onboarding gate) `GET /api/auth/me` returns `setupAdmin: { name }` (the first active ADMIN, name only) only while `tenantStatus` is PENDING_ONBOARDING or PENDING_ADMIN_SETUP.
- (Triggers round, 2026-10-07) Inventory against the catalogue (mine and the supervisor's agree). Live now: message_from_ad (the first message of an ad conversation, optional ad ids), button_tapped (a tap with no flow waiting), and the "AI writes a message" node (ai_generate was a stub that always wrote ""; now the employee's one-shot through services/ai, logged and metered). call_missed/call_answered were offered live with no producer: now unavailable until voice events feed the dispatcher. Next, in order: cart_abandoned, comment_received (+ public reply), voice events, order_event, story_mention. Candidates found, not scheduled: "no reply for N hours" (the idle worker detects it after an agent's message), conversation:closed, crm.stage.changed.
- (Triggers round, 2026-10-07) Cart left behind is live (dbe14332, 9bc922e7, 5d3c8ea7): Shopify checkouts/orders webhooks and a gentle WooCommerce poller feed one cart event; a delayed check per automation; consent required (store record or granted ConsentRecord, opt-out wins), else a `skipped` run with the reason; a purchase stops a waiting run; WhatsApp is template-only. Shopify checkouts need `read_orders` and Protected Customer Data approval (Omer's side).
- (Triggers round, 2026-10-07) Comment on a post is live in code (1e475948): trigger `comment_received` + node `send_comment_reply`. It runs before the playbook's comment triggers and takes the comment from them. The comment walker runs the steps up to the first Wait for reply; there the run parks in the DM conversation and continues in the normal walker. Two fixes to the 24 h comment bridge for automation runs: the wait timer is capped inside the window (the idle sweep closes the bridge at 24 h), and the customer's DM reply clears the bridge marker (the sweep used to be able to close a conversation the customer was in). A send Meta refuses ends the run `failed` (the playbook's comment walk is unchanged).
- (DECIDED, Omer, 2026-10-08, confirmed directly) **Marketing works by opt-out. This replaces the explicit-consent requirement on WhatsApp**, for an abandoned cart, a review request (when it exists) and a campaign:
  - **Who may get it:** a customer with prior contact (an inbound message on any of their channels) OR the store's consent (Shopify) OR a granted ConsentRecord. An opt-out ALWAYS wins. One gate, `marketingGate` (incoming-worker cart.service), serves carts and order messages; a new WhatsApp conversation is opened only for a customer who may be written to.
  - **Every marketing message carries the removal line** "להסרה השיבו הסר" / "Reply STOP to unsubscribe". On WhatsApp it is part of the template's TEXT, not a button: Omer wants the reply, because it is interaction that is good for the number. Enforcement:
    - A MARKETING template gets the line on create, update and duplicate, in its language. One without it is not submitted to Meta (422 `MISSING_REMOVAL_LINE`).
    - A send of a MARKETING template (or any template from a cart run) without it is skipped (`skipped_missing_removal_line`).
    - A campaign whose template lacks it is refused before anything is queued (422). A text campaign and a cart run's free text get it appended.
  - **A reply of "הסר" / "STOP" / "unsubscribe" (and close variants; the whole message, never a word inside a sentence)** opts the customer out on that channel (`Contact.optOutChannels`). It also appends a `granted=false` ConsentRecord and an audit entry (`gdpr.consent_withdrawn`, source `reply_keyword`), and answers with a short confirmation in the reply's language. Nothing else answers that message, whoever owns the conversation. Opt-out reads compare channels without case (the broadcast and scheduled workers used to compare exactly).
  - **Risk, accepted by Omer when asked:** Meta's WhatsApp Business policy expects opt-in before business-initiated marketing. Sending on prior contact alone can lower the number's quality rating or draw blocks or restrictions. The removal line and the always-winning opt-out are the mitigation.
  - **Not covered:** an opt-back-in reply ("START") is not handled; a person can clear an opt-out on the contact (`POST /api/contacts/:id/opt-out`, which writes no audit entry: a gap). Meta's own "stop promotions" signal (error 131050) is not read yet.
- (Comments, 2026-10-07) A comment carries only the commenter's username, which is not a name: before the first Wait for reply `{{first_name}}` renders empty and the catalogue offers `{{comment.from.username}}` instead; after it the DM steps fill `{{first_name}}` as usual and still read `{{comment.*}}`.
- (Triggers round, 2026-10-07) Call missed / Call answered are live in code: the ONE producer is the shared call-state transition (every terminal state passes it), which queues a durable `automation-event` for an inbound call that was missed, or answered and ended (a queue failure never fails the call). The incoming worker writes to the caller on WhatsApp, template only, with call variables; one run per call (`call:<sessionId>`). "Voice connected" now means an ACTIVE voice line (CommunicationChannel), not a VOICE channel account (dev has neither, so on dev these stay `not_connected` until a line exists). Fixed on the way: the phone-to-conversation lookup (shared with carts) could pick the call's own VOICE conversation, where nothing can be written.
- (Triggers round, 2026-10-07) Order event is live in code: Shopify orders/create|paid|fulfilled|cancelled receivers (subscription in the app TOML still waits for Protected Customer Data approval, like checkouts) and the WooCommerce poller (the same gentle read as carts; chosen over registering a webhook on each store, which would write to the customer's store and add a public endpoint). Decision taken, flag for Omer: order messages need no marketing consent (the customer's own purchase), an opt-out wins; an "Ask for a review" sent days later is closer to marketing, and its WhatsApp template category is where Meta enforces that.
- (Triggers round, 2026-10-07) Story mention is live in code: the Instagram adapter kept only the text "[Story mention]" and dropped the story link; the link now travels adapter → webhook (message metadata, the existing producer-metadata path) → the message row and the inbound automations, where a story mention fires `story_mention` automations instead of `message_received`. Order of the round complete: 1-3, 7, 5, 6, 8, 4. Still unavailable: form_submitted (no form source exists).
- (Knowledge, 2026-10-07) Cross-language retrieval: when a question's script differs from the script most of the tenant's Knowledge is in (cached an hour), the question is translated (gpt-5-nano, reasoning "minimal", 2.5 s timeout, budget sized to the question; through generateResponse, so logged, audited and charged like every call, feature `knowledge_query_translation`) and both are searched, each chunk at its best score. A refusal (no credits), failure or timeout falls back to the direct search. Measured on dev: "What do you sell?" 0.321 → 0.354 (the Hebrew question scores 0.355); "How can I reach you?" 0.122 → 0.265. Translation takes 0.7-1.8 s, in parallel with the first embedding; only mismatched messages pay it.
- (Knowledge, 2026-10-07) Gap threshold 0.35 → 0.30 (`KNOWLEDGE_GAP_SCORE`, services/ai knowledge.service; moved out of shared, its only reader), applied to the best of both searches. Measured: answerable questions 0.294-0.428 (median ~0.35), unanswerable 0.191-0.312 (median ~0.27). 0.35 recorded four of six ANSWERED questions as gaps; 0.30 records one (0.294) and misses two unanswered (0.308, 0.312). The ranges overlap; a two-document sample is thin, so re-measure on a tenant with richer Knowledge.
- (Knowledge, 2026-10-07) Onboarding preview: "What do you sell?" was not retrieval but the model refusing (the overview says the store is password-protected, "no product descriptions were found"). The prompt now says excerpts in another language count once translated, and a general answer they support (the kind of business or products) is covered.
- (Knowledge, 2026-10-07, live on dev) Translation cost per mismatched message: $0.000026 on average (19 calls, gpt-5-nano, ~35 prompt + ~60 completion tokens), charged as AI usage under `knowledge_query_translation`. Live check: "What do you sell?" grounded on the overview; "How can I reach you?" grounded on what the documents hold (the store's website, and that no public contact details were found); "כרטיסי מתנה בירושלים?" not grounded; an answered question added no unanswered row.
- (Test debt, 2026-10-07, OWNER NEEDED before main) services/ai: 19 test files fail at HEAD too, independent of the triggers / knowledge work (measured by swapping that work back to HEAD: 67 failures without it, 66 with): action-executor-http.test.ts, action-executor.test.ts, ai-bot-e2e.test.ts, ai.test.ts, behavior-engine.test.ts, chaos.test.ts, crm-adapter.smoke.test.ts, crm-panel-routes.smoke.test.ts, followup-generator.test.ts, historical-completion-email.test.ts, historical-reusability.test.ts, integration-verification.test.ts, knowledge-agent-scoping.test.ts, security/cost-budget.test.ts, security/output-validator.test.ts, shopify-chat-public.test.ts, shopify-webhooks.test.ts, smoke-fixes.test.ts, tool-surface-authority.test.ts. Not investigated; some may come from other sessions' uncommitted changes in services/ai.

### Test triage: services/ai files failing at HEAD (2026-10-07)

No production bug found, and nothing depends on a DB or network that is missing. 18 of the 19 files fail because the test fell behind the code: a mock that replaces all of `@chatcenter/shared` lacks a function the code now uses, or an expectation predates a deliberate change. The 19th fails because of another session's uncommitted edit. Every fix touches only the test.

| file | failing | cause | since | recommendation |
|---|---|---|---|---|
| action-executor-http.test.ts | 7/7 | mock lacks `getPolicy` (policy.service now re-exports shared) | dc42b948 2026-09-14 | fix test (policy stub) |
| action-executor.test.ts | 3/7 | mock lacks `getPolicy`/`setPolicy` | dc42b948 2026-09-14 | fix test (in-memory policy stub + real validateAgainstPolicy) |
| ai-bot-e2e.test.ts | 9/14 | mock lacks `getPolicy` | dc42b948 2026-09-14 | fix test (same stub) |
| chaos.test.ts | 3/3 | mock lacks `getPolicy`/`validateAgainstPolicy` | dc42b948 2026-09-14 | fix test (same stub) |
| followup-generator.test.ts | 1/3 | mock lacks `getPolicyPrompt` | dc42b948 2026-09-14 | fix test |
| ai.test.ts | whole file (0 run) | mock lacks `requireInternalKey` (+ ~5 more: resolveConversationLocale, resolveEffectiveLocale, requireEntitlement, getRedis, requireVisibleConversation) | 3a6d66ff 2026-07-18, then c1b57691, 9c5e96cc, fa4f1de3 | fix test (spread importActual; not quick) |
| behavior-engine.test.ts | 3/91 | expectations predate deliberate rules: "demo" is now a transactional marker (no "funnel-overridden" tag); a deferral with no time asks when (ask_question), not schedule_followup | 3d0e06ff 2026-05-26; 002fe681 2026-05-17 | fix test (+ add a timed deferral case) |
| smoke-fixes.test.ts | 2/13 | same deferral rule (no hour → ask_question); test and rule landed together, so likely never passed | 002fe681 2026-05-17 | fix test (product check: confirm "ask when" is wanted) |
| crm-adapter.smoke.test.ts | 6/21 | resolver now asks for Shopify first (a mockResolvedValueOnce is consumed by it); sentiment now rendered "Positive" | aae3a981 2026-06-08 / fffd248d 2026-07-21; 5c6682c8 2026-06-15 | fix test |
| crm-panel-routes.smoke.test.ts | 6/13 | mock lacks `assertPublicUrl` (Zoho fetch "blocked_host") and `resolveEffectiveLocale` (throws before .catch → timeout) | 3a6d66ff 2026-07-18; 3d0e06ff 2026-05-26 | fix test |
| integration-verification.test.ts | 2/44 | real `assertPublicUrl` (SSRF guard) does DNS for shop.example.com → ENOTFOUND; the error is swallowed | 3a6d66ff 2026-07-18 | fix test (stub assertPublicUrl) |
| historical-reusability.test.ts | 1/24 | expects "PRODUCT" → OTHER; normalization now maps it to PRODUCT_AND_SPECS on purpose (asserted elsewhere) | f63e878f 2026-08-26 | fix test |
| knowledge-agent-scoping.test.ts | 1/9 | source-text regex expects a one-line call; the call now spans lines with a 5th argument (behaviour correct: agent id passed) | 0bc2f39c 2026-09-08 | fix test (whitespace-tolerant regex) |
| security/cost-budget.test.ts | 2/11 | mock returns `_sum.tokensTotal`; code reads `_sum.tokensEquivalent` → usage 0, cap never trips | 5c6682c8 2026-06-15 | fix test |
| security/output-validator.test.ts | 16/27 | mock lacks `reportOperationalFailure`/`ERROR_CODES` (called on every violation) | ac1b5bb8 2026-08-03 | fix test |
| shopify-chat-public.test.ts | 1/29 | /handoff now calls recordHandover → needs `$transaction` + `conversationHandover.create` in the mock | cd9c5c88 2026-09-08 | fix test |
| shopify-webhooks.test.ts | 2/25 (uninstall) | `notifyShopifyUninstalled` not mocked: a real fetch runs late and spills into the next test | e62d2c0f 2026-09-03 | fix test (mock the billing bridge) |
| tool-surface-authority.test.ts | 1/3 | catalog tools without `endpoint` are now dropped; the fixture sets none | 3b3ed8ef 2026-08-02 | fix test (add endpoint) |
| historical-completion-email.test.ts | 1/13 | UNCOMMITTED edit by another session (bulk em-dash scrub) turned `/[–—]/` into `/[–-]/`, so normal hyphens fail | uncommitted | the scrub's owner restores `/[–—]/` |

Structural cause: these suites replace all of `@chatcenter/shared`, so every new shared function the code calls breaks them silently. A lasting fix is to spread `vi.importActual` and override only what each test needs.

Fixed 2026-10-07 (40a54757, test files only, real shared module + per-test overrides): 16 of the 19 files. ai suite: 19 failing files / 66 tests → 3 files / 6 tests. Still red, on purpose: behavior-engine (3) and smoke-fixes (2), waiting on Omer's product answer about vague deferrals ("call me tomorrow": ask when vs schedule a follow-up); historical-completion-email (1), Omer's uncommitted dash sweep (restore the regex as `/[–—]/` if asked).

- (DECIDED, Omer, 2026-10-07) Order messages: sent only to a customer who has written to the business before (an inbound message on any of their channels) or gave consent (the store's own record, else a granted marketing ConsentRecord); otherwise skipped with `no_prior_contact_or_consent`. Every order message, status updates included. An opt-out always wins. No new conversation is opened for a customer about to be skipped. (Supersedes the earlier "no consent for the customer's own order".)
- (DECIDED, Omer, 2026-10-07) A deferral with no time ("call me tomorrow") asks what time; only a stated time schedules the follow-up. The code already did this; the tests now say so.
- (Release note, 2026-10-07) Migration `20261007120000_drop_channel_response_mode` must run only AFTER every backend image is rebuilt with the new schema (each image bakes its Prisma client; an old client selects `response_mode` on unselected channel-account reads). Omer deferred it on dev to the next full rebuild. For production: deploy all images first, migrate last.

### Assistant figures and their sources (2026-10-07)

The assistant must say the number the screen in front of the owner says. Live test: "how many waiting?" answered 3 (status WAITING) while Home said 21 and the inbox queue 10.

| assistant metric | means | source (same as the screen) |
|---|---|---|
| `waiting_for_person` | conversations waiting for someone on the team to answer | analytics `waitingForPersonWhere` via `GET /api/analytics/queue/items` (Home's "waiting on you" count and its ranked queue; unassigned, open, not answered by the AI or a flow unless handed over, not a rehearsal). Asked with the user's own token. |
| `pending_approvals` | actions waiting for approval | `status PENDING and expiresAt > now`, as Home's metric strip (`getOverview.pendingApprovalCount`) and the Approvals list |
| `open_conversations` | all open conversations, AI-answered included | direct count, rehearsals excluded (not shown as such on a screen) |
| `closed_today` | conversations closed since midnight | direct count, rehearsals excluded |
| `inbound_messages_24h` | customer messages in the last 24 h | direct count, rehearsals excluded |

Fixed with it: Home's "waiting on you" (`getQueueDepth`) counted conversations the AI was answering (21) while Home's own ranked queue excluded them; both now use one predicate. The old metric `waiting_conversations` (status WAITING, which no screen shows) now maps to `waiting_for_person`. Tool results carry a plain-words `label` instead of status keys or the query; steps are human ("Counting the conversations waiting for your team"), in the interface language. The answer follows the language of the question (fallback: the interface language).

Open, for Frontend: v2 uses "waiting on you" for two figures, the people queue (StatusStrip) and pending approvals (MetricStrip, `analytics.ts:436`). One of the two labels should change.
- (Future, 2026-10-07) Website widget: one channel in the data (`WEBSITE_WIDGET` with source code/shopify/woocommerce) instead of WEBCHAT + SHOPIFY_LIVE_CHAT. Not now; after stages A and B (docs/product/website-widget.md).
- (2026-10-07) The inbox's "Waiting in queue" view is now `GET /api/conversations?view=queue`: exactly "waiting for a person" (the shared `waitingForPersonClause`, `packages/shared/src/lib/conversation-queue.ts`, also used by Home's count and ranked queue and, through analytics, the assistant), with `viewTotal` for its header (visibility applied). Without `view=queue` the list keeps its old default (every status and assignee, AI/flow-owned excluded) for other callers. Before: the view listed closed and assigned conversations too (10 vs Home's 9).
