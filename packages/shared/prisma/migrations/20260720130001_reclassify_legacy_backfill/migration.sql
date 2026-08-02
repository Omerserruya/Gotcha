-- Part 2 of 2: stop lying about history.
--
-- 20260720100000_hitl_execution_state backfilled every pre-state-machine
-- APPROVED row to SUCCEEDED so the new sweeper would never re-run a historical
-- action. Right goal, wrong label: the Matan Amran Shopify approvals
-- (execution_attempts=0, no recorded result) were PROVEN never to have
-- executed, yet read as SUCCEEDED. Reclassify exactly the backfilled shape -
-- zero attempts, no recorded result, no recorded error, execution_ended_at
-- stamped equal to the decision time - to LEGACY_UNVERIFIED.
--
-- Retry-prevention is preserved structurally: claimForExecution claims only
-- NOT_STARTED/FAILED, the stranded-execution sweeper targets only NOT_STARTED,
-- and claimCustomerNotification requires SUCCEEDED. LEGACY_UNVERIFIED is
-- terminal and audit-only.
UPDATE "approval_requests"
SET "execution_state" = 'LEGACY_UNVERIFIED'
WHERE "status" = 'APPROVED'
  AND "execution_state" = 'SUCCEEDED'
  AND "execution_attempts" = 0
  AND "execution_result" IS NULL
  AND "execution_error" IS NULL
  AND "execution_started_at" IS NULL;

-- The backfill also stamped customer_notified_at = decided_at on rows where no
-- customer message row exists (customer_message_id IS NULL). Clear the stamp on
-- reclassified rows so the audit trail doesn't claim a notification that never
-- happened. Safe: notification claims require execution_state = SUCCEEDED, so
-- clearing this can never cause a late "it's done" message for legacy rows.
UPDATE "approval_requests"
SET "customer_notified_at" = NULL
WHERE "execution_state" = 'LEGACY_UNVERIFIED'
  AND "customer_message_id" IS NULL;
