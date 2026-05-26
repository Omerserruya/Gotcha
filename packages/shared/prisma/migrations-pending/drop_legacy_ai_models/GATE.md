# Gate: Attach voice channels to AIAgent (formerly "drop legacy AI models")

**Status:** parked, not deployed.

## Direction correction

The earlier draft of this migration **dropped** `AIAgent` and introduced
a new `AIWorker` Prisma model. That was the wrong direction.

The corrected design:

- **`AIAgent` stays** as the canonical AI Employee record
- **`voice_channels` gets a new `ai_agent_id` FK** so voice channels
  attach to the same AI Employee that already runs chat + copilot
- The legacy `voice_channels.copilot_config` JSONB fields are **migrated
  onto the AIAgent record** the channel now references (or left in place
  read-only until the call sites stop reading them, then dropped)
- The `call_playbook` → funnel fold (Phase 2b codemod) is a separate
  effort and continues unchanged
- **Nothing about `AIAgent` is dropped** — `description`, `systemPrompt`,
  `tone`, etc. all stay; the unified worker reads them via the cutover
  shim (`workerConfigFromAgent`)

## What this migration does

1. `ALTER TABLE voice_channels ADD COLUMN ai_agent_id TEXT REFERENCES ai_agents(id) ON DELETE SET NULL`
2. Backfill: for each voice channel with a non-empty `copilot_config`:
   - If the tenant has exactly one active `AIAgent` and the operator
     hasn't manually picked one, link to that agent
   - Otherwise, leave `ai_agent_id = NULL` and surface the channel in
     the admin UI's "Voice channels needing an AI Employee" panel
3. Optionally copy `copilot_config.language` / `persona` onto the
   linked AIAgent **iff** the agent has those fields blank (so we don't
   stomp existing employee config)
4. `copilot_config` column **stays for the migration window** as a
   read-only fallback. Dropped in a follow-up after every voice call
   site reads from the agent.

## Why it's parked

The unified AI Worker (`services/ai/src/worker/`) supports both paths
already via `cutover-shim.ts`:

- `workerConfigFromAgent(agent, mode, skillIds)` — canonical, used when
  `voice_channels.ai_agent_id` is populated
- `workerConfigFromLegacy(agent, channelConfig, ...)` — transitional,
  used while a voice channel still has only `copilot_config`

Running this migration is safe at any point, but the value lands when
the voice call sites (`live-analysis-runner.ts`,
`copilot-config-loader.ts`) are updated to prefer the FK over
`copilot_config`. Those updates are part of Phase 5 cutover.

## Promotion checklist

Before moving this migration into `prisma/migrations/`:

- [ ] Phase 5 cutover for `callpilot` site flipped — the live runner
      reads the AIAgent reference when present
- [ ] Admin UI surfaces "Voice channels using this employee" on the
      AIAgent editor page (Phase 7 design doc)
- [ ] Backfill script dry-run report inspected — operator approves
      auto-link decisions per tenant
- [ ] Rollback plan: the new FK is nullable + `ON DELETE SET NULL`, and
      the `copilot_config` column is retained as the fallback — so
      reverting is a one-line code change (call site reads
      `copilot_config` again), no data loss

After promotion:

```bash
git mv packages/shared/prisma/migrations-pending/drop_legacy_ai_models \
       packages/shared/prisma/migrations/$(date -u +%Y%m%d%H%M%S)_voice_channels_ai_agent_fk
cd packages/shared && pnpm prisma migrate deploy
```

## Follow-up migration (separate gate)

Once every voice call site has been observed reading from
`voice_channels.ai_agent_id` for ≥ 1 week with zero null-FK fallbacks,
a follow-up migration can drop `voice_channels.copilot_config`. That's
intentionally a separate file so the FK addition can ship without
committing to the data drop.
