-- Grammatical address: which FORM to write replies in for one conversation.
--
-- Additive, nullable, no backfill. Every existing conversation reads as
-- "unknown", which is the correct starting state and produces neutral,
-- restructured phrasing rather than a guess.
--
-- Deliberately on `conversations` and NOT on `customers`:
--
--   • It is a property of one conversation's language use, not of a person.
--     A customer who writes to us in masculine forms one day and hands the
--     phone to their partner the next has not changed identity.
--   • Putting it on `customers` would create the exact row a CRM writeback,
--     a Shopify customer tag or a segmentation query would eventually pick
--     up. There is no such row, so there is nothing to pick up.
--
-- Shape: { form, confidence, sourceMessageId?, language?, updatedAt? }
-- See packages/shared/src/lib/grammatical-address.ts for what may and may
-- not become evidence for it.

ALTER TABLE "conversations" ADD COLUMN "grammatical_address" JSONB;
