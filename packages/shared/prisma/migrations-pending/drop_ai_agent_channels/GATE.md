# Gate: drop_ai_agent_channels

**Status:** parked, not applied anywhere (checked on dev 2026-10-09: no
`_prisma_migrations` row; the column still exists).

## Why it waits

The schema already lacks this field, so a Prisma client generated from it never
selects it. But every backend image bakes its OWN client: an image built before
the field left the schema still selects it on any read without a `select`, and
fails the moment the column is gone. In `migrations/`, `prisma migrate deploy`
would drop it on the next deploy while older images are still running. Omer
(2026-10-07): apply at the next full rebuild.

## Gate

Every backend image (ai, auth, conversation, notifications, billing, chatbot,
analytics, webhook, incoming-worker, outgoing-worker, voice-copilot) is rebuilt
from a commit whose schema no longer has the field, and none of the old images
is still running.

## Promote

1. Confirm the gate (the running image ids against their build commits).
2. `git mv migrations-pending/drop_ai_agent_channels migrations/<timestamp>_drop_ai_agent_channels`, with a timestamp
   later than every migration already applied.
3. `prisma migrate deploy` against staging, then production.

`packages/shared/src/__tests__/held-migrations.test.ts` fails if this drop
reaches `migrations/` without this file being updated with the release that
promotes it.
