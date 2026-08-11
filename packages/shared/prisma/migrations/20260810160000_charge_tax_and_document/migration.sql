-- What a charge was made of, and the document issued for it.
--
-- Catalogue prices are net, so the amount submitted to the provider is not the
-- amount on the plan. Keeping the three figures apart means a receipt can be
-- reconciled against the charge without recomputing tax from a rounded total.
--
-- Additive only: five nullable columns. Existing rows keep NULL, which reads
-- correctly as "charged before tax was itemised".

ALTER TABLE "charges" ADD COLUMN "net_amount" DECIMAL(12,2);
ALTER TABLE "charges" ADD COLUMN "tax_percent" DECIMAL(5,2);
ALTER TABLE "charges" ADD COLUMN "tax_amount" DECIMAL(12,2);
ALTER TABLE "charges" ADD COLUMN "document_ref" TEXT;
ALTER TABLE "charges" ADD COLUMN "document_url" TEXT;

CREATE INDEX "charges_document_ref_idx" ON "charges"("document_ref");
