-- Per-recipient resolved template variable values, snapshotted at
-- broadcast materialize time. Lets the send worker substitute per-
-- recipient values (e.g. {{1}} = "Omer" for one row, "נועם" for the
-- next) without re-hitting the CRM at fan-out.
ALTER TABLE "broadcast_recipients" ADD COLUMN "variables" JSONB;
