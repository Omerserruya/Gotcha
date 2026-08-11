-- The pay-as-you-go rate belongs to the CATALOG.
--
-- It was added to AutoPurchasePolicy first, which made it a number somebody
-- would have to type once per tenant - and, since nothing wrote it, a number
-- nobody could type at all. Pricing a product is a catalog decision, so the
-- plan carries it and the policy column stays as a per-tenant override.
--
-- NULL means the plan is not sold pay-as-you-go. The gate reads that as a
-- refusal to serve past a spent wallet, never as permission to serve it free.
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "payg_price_per_credit" DECIMAL(12,6);
