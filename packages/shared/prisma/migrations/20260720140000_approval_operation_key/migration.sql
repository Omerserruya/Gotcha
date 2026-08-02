-- Business-operation fingerprint for HITL dedup.
--
-- Row-level CAS guards (claimForExecution / claimCustomerNotification) are
-- airtight per row, but two ApprovalRequest rows describing the SAME business
-- operation (two "refund order #1004" rows) each carried their own once-only
-- notification - the customer was told twice. operation_key names the
-- operation itself so creation and notification can dedup across rows.
ALTER TABLE "approval_requests" ADD COLUMN "operation_key" TEXT;
CREATE INDEX "approval_requests_tenant_id_operation_key_idx"
  ON "approval_requests" ("tenant_id", "operation_key");
