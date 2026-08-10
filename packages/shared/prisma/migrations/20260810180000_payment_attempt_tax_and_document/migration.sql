-- What a self-serve checkout charge was made of, and the document it produced.
--
-- The Charge table already carries these. PaymentAttempt is the OTHER charging
-- path - the first, self-serve payment - and without them that payment was the
-- one a new customer is most likely to ask about and the one we could say
-- least about.
--
-- Additive only: five nullable columns, nothing dropped, no existing value
-- changed. Safe to apply ahead of the code that reads it.

ALTER TABLE "payment_attempts" ADD COLUMN "net_amount" DECIMAL(12,2);
ALTER TABLE "payment_attempts" ADD COLUMN "tax_percent" DECIMAL(5,2);
ALTER TABLE "payment_attempts" ADD COLUMN "tax_amount" DECIMAL(12,2);
ALTER TABLE "payment_attempts" ADD COLUMN "document_ref" TEXT;
ALTER TABLE "payment_attempts" ADD COLUMN "document_url" TEXT;
