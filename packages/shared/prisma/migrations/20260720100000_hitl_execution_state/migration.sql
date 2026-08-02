-- HITL: separate the human DECISION from the ACTION's execution.
--
-- `approval_requests.status` only ever recorded what a manager clicked.
-- Everything after that - whether the tool actually ran, whether it succeeded,
-- and whether the customer was told - lived nowhere. Consequences in
-- production: a failed dispatch left an APPROVED row identical to a successful
-- one, no worker could retry it, and the conversation was un-paused as if all
-- was well. These columns make the execution a first-class, resumable state.

CREATE TYPE "ExecutionState" AS ENUM ('NOT_STARTED', 'EXECUTING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "approval_requests"
  ADD COLUMN "execution_state"      "ExecutionState" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "execution_started_at" TIMESTAMP(3),
  ADD COLUMN "execution_ended_at"   TIMESTAMP(3),
  ADD COLUMN "execution_result"     JSONB,
  ADD COLUMN "execution_error"      TEXT,
  ADD COLUMN "execution_attempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "customer_notified_at" TIMESTAMP(3),
  ADD COLUMN "customer_message_id"  TEXT,
  ADD COLUMN "decision_channel"     TEXT,
  ADD COLUMN "correlation_id"       TEXT;

-- The resume sweeper's access path: approved-but-not-yet-executed, and
-- executed-but-customer-not-yet-told.
CREATE INDEX "approval_requests_status_execution_state_idx"
  ON "approval_requests" ("status", "execution_state");

-- Backfill: existing APPROVED rows ran inline at approval time under the old
-- code, and their customer message (if any) was already sent. Marking them
-- SUCCEEDED + notified prevents the new sweeper from re-executing historical
-- actions - re-running a refund or a booking would be far worse than leaving
-- an old row un-annotated.
UPDATE "approval_requests"
SET "execution_state" = 'SUCCEEDED',
    "execution_ended_at" = COALESCE("decided_at", "updated_at"),
    "customer_notified_at" = COALESCE("decided_at", "updated_at")
WHERE "status" = 'APPROVED';
