-- Marks a payment attempt as consumed by an activation. The conditional UPDATE
-- on this column is what makes a duplicate activation grant credits exactly
-- once, even under concurrent calls.
ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "consumed_by_activation_at" TIMESTAMP(3);
