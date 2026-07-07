-- P1-3 (B6): kernel-originated approvals resume through the Capability Runtime.
-- The gate stores the full ExecutionRequest here; dispatch re-enters the Runtime
-- by operation instead of the legacy tool executor.
ALTER TABLE "approval_requests" ADD COLUMN "resume_envelope" JSONB;
