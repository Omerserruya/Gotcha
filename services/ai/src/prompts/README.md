# `prompts/` — Authoring Guide

This folder holds the **editable markdown layers** that the prompt builder stitches together into the final system prompt sent to the LLM on every turn.

You can edit these `.md` files directly — they are loaded at module init by [`prompt-builder.service.ts`](../services/prompt-builder.service.ts) and applied per the compile order below. **No code change needed to update text.**

> ⚠️ **Cache discipline.** OpenAI charges full price for the cache-miss tokens but ~10% for cached prefix tokens. Our prompt is structured as three blocks (per-agent → per-conversation → per-turn) and the **byte-stable prefix** must not drift. Editing a static-layer file (`guardrails.md`, agent identity) is fine — every conversation will re-cache on next turn. But **do not** introduce per-turn variability into static layers. See "Cache rules" below.

---

## Compile order — every turn

The final prompt is built in **three blocks**, joined by `---` separators. Order is load-bearing for OpenAI prefix caching.

```
[ BLOCK 1 — Per-AGENT ]   ← static; same for every conversation this agent runs
   1. # Identity              ← AIAgent row (name, role, tone, persona)
   2. # Agent Playbooks       ← AIAgent.playbooks (DB)
   3. # Guardrails            ← guardrails.md  ★ editable here
   4. ## Additional Business  ← AIAgent.customGuardrails (DB)
   5. ## Truthfulness         ← inline TRUTHFULNESS_FOOTER

---

[ BLOCK 2 — Per-CONVERSATION ]   ← stable for the lifetime of one chat
   6. # Conversation Context  ← customer block, CRM, memory, templates
   7. Language Skill          ← hebrew.md (if locale=he)  ★ editable here

---

[ BLOCK 3 — Per-TURN ]   ← fresh every turn — MUST come last for cache
   8. # Conversation State    ← BehaviorState (BEL output)
   9. # Pipeline Stage        ← active funnel stage
  10. # Goals                 ← strategy primaryGoal
  11. # Decision Layer        ← BEL decision intent + posture
  12. # Active Playbooks      ← dynamic playbook selection
  13. ## Forbidden in turn    ← strategy.forbiddenBehaviors
  14. # Knowledge Base        ← RAG retrieval (when relevant)
  15. # Execution Contract    ← MANDATORY action gates
  16. # Tools                 ← filtered tool surface
```

Sections **3** and **7** are sourced from this folder. Everything else is composed in-code from structured DB fields or the Behavior Engine's per-turn output.

---

## The five pillars every well-formed agent prompt needs

The user's [request](../../README.md) was that every agent prompt must include these five pillars. Here's how each maps to the compile order above:

| # | Pillar | Where it lives today |
|---|---|---|
| 1 | **Self-introduce** — how the bot opens & names itself | `# Identity` (section 1) — sourced from `AIAgent.identity.intro` + `agent.tone`. Edit on the agent's settings page, not here. |
| 2 | **Goal** — funnel stage or main goal | `# Goals` (section 10) + `# Pipeline Stage` (section 9). Sourced from `STRATEGY_CONTRACTS[strategy].primaryGoal` (frozen, platform-level) and the agent's `funnel` (if any). |
| 3 | **Client-serving manner** — empathy, brevity, professionalism | Distributed: `# Identity` (tone, persona traits), `# Forbidden in turn` (strategy.forbiddenBehaviors), and the language skill (sect. 7) for locale-specific style. |
| 4 | **Tech rules** — "always look for X before calling tool Y" | `# Execution Contract` (section 15) — strongest scaffolding in the prompt. Built per-turn from BEL decision intent + tool gating. To add a new tech rule, edit `prompt-builder.service.ts` `buildExecutionContract()`, NOT here. |
| 5 | **Language rules** — locale style | This folder: `hebrew.md` for `locale=he`. Add `arabic.md`, `spanish.md`, etc. as needed and wire them in `languageSkillBlock()` in the builder. |

---

## Files in this folder

### `guardrails.md` — Loaded into every prompt (BLOCK 1)
Hard rules the bot must never violate: data privacy, brand safety, jailbreak resistance, scope control, customer data boundaries, authority hierarchy. **This is the safety layer.** Editing here changes behavior for every agent in every tenant.

### `hebrew.md` — Loaded only when `locale === "he"` (BLOCK 2)
Hebrew style skill: natural Israeli phrasing, qualifying-questions ladder, idioms (סגור, פיקס, בכיף), opener words (אז, אגב), info-gathering order. The customer's language is detected by `detectLocale()` in `ai-bot.service.ts`.

### Other `.md` files in this folder

These exist for unrelated AI flows and are **not** loaded into the autonomous chatbot's prompt:
- `system-copilot.md` — used by the System Copilot (Command Center)
- `intent-classifier.md`, `action-planner.md` — legacy flows; not currently imported

---

## Cache rules — read before editing

The prompt is split into three blocks for one reason: **OpenAI caches the prefix**. If you preserve byte-stability in BLOCK 1 and BLOCK 2 across turns, the model only pays full price for BLOCK 3 (per-turn). This is roughly a **10× cost reduction** on long conversations.

**Do** edit static-layer files (`guardrails.md`, identity copy in the agent settings). One re-cache happens on next turn. Cheap.

**Do not** add per-turn variability to a static-layer file:
- ❌ Don't reference "this turn" / "today's date" / counters in `guardrails.md`.
- ❌ Don't add `${customerName}` / `${nowIso}` placeholders to static files. Those belong in BLOCK 3 sections.
- ❌ Don't load a static file conditionally on per-turn state. If you need per-turn rules, build them in `prompt-builder.service.ts` `buildTurnBlock()`.

**To add a new language skill:**
1. Drop `<locale>.md` in this folder.
2. In `prompt-builder.service.ts`, add a `readPrompt("<locale>.md")` constant near `HEBREW_SKILL`.
3. Add a branch in `languageSkillBlock()` returning that constant when the locale matches.
4. (Optional) Update `detectLocale()` in `ai-bot.service.ts` if the language needs new Unicode ranges.

---

## Authoring tips

- **Speak to the LLM, not the user.** These files are read by the model, not the customer. Use imperative voice ("Refuse X", "Do not Y"). The customer never sees these strings.
- **Examples > rules.** `✓ "<good>"` / `✗ "<bad>"` pairs work better than abstract prescriptions.
- **Length costs money.** Every word in BLOCK 1 is sent on every turn (cached after turn 1, but still in the message stream). Keep it tight.
- **One source of truth.** If a rule belongs to a specific strategy (e.g., "in QUALIFY, ask only one question per turn"), put it in `behavior-strategies.ts`, NOT here. This folder is for cross-strategy, agent-wide rules.
