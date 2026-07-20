-- Part 1 of 2 (see 20260720130001): add the enum value only.
-- Postgres cannot ADD VALUE and USE the new enum value inside one
-- transaction, and Prisma wraps each migration in a transaction - so the
-- reclassification UPDATE lives in the follow-up migration.
ALTER TYPE "ExecutionState" ADD VALUE IF NOT EXISTS 'LEGACY_UNVERIFIED';
