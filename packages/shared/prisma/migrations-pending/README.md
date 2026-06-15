# Pending migrations

Migrations parked here have been authored but are **not** picked up by
Prisma yet. They sit in this directory until their rollout gate is met,
at which point a maintainer moves the folder into `prisma/migrations/`
and runs `prisma migrate deploy`.

This pattern is used when a migration's gate is **time-based or
behavioural** ("one week green on the unified worker", "after every
caller has migrated") - Prisma has no native equivalent, and a
half-applied migration in a hotfix branch is far worse than a folder
sitting on disk.

## Workflow to promote

1. Verify the gate is met (see the migration's own `GATE.md`)
2. `git mv migrations-pending/<name> migrations/<timestamp>_<name>`
3. `cd packages/shared && pnpm prisma migrate deploy` (against staging first)
4. Verify nothing reads from the dropped tables in staging
5. Repeat against prod
