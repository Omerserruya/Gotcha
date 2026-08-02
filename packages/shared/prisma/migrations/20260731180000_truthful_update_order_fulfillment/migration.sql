-- Stop `update_order_fulfillment` describing itself as an operations handoff.
--
-- The catalog row said "Add a note + tag to an order (non-destructive ops
-- handoff)." and the adapter's model-facing whenToUse said "Flag an order for
-- the ops team." Neither is true: the handler writes a note and a tag onto the
-- Shopify order and notifies nobody. No task, no assignment, no queue item, no
-- message.
--
-- A tool description is a promise the model repeats to the customer. On
-- 2026-07-31 it repeated this one as "אני פונה לצוות המשלוחים" - "I am
-- contacting the shipping team" - to a customer waiting on a delivery. Nobody
-- was contacted. He escalated and then asked to cancel the order.
--
-- The adapter-side strings are fixed in shopify.adapter.ts (what the MODEL
-- reads). This fixes the catalog row (what the ADMIN reads on the Integrations
-- & Tools page), so the two stop disagreeing.
--
-- Idempotent: matches on the old text, so re-running after a manual edit does
-- nothing.

BEGIN;

DO $$
DECLARE n INT;
BEGIN
  UPDATE catalog_tools
  SET description = 'Adds a note and optional tag to the Shopify order. Records context on the order only: it does NOT notify, assign or contact any person or team.',
      when_to_use = 'Use when order context should be recorded in Shopify. Never tell the customer a team, carrier or person was contacted on the strength of this tool - it reaches no one. Say a team was contacted only after a notification, task or assignment tool returns success.'
  WHERE slug = 'update_order_fulfillment'
    AND (description LIKE '%handoff%' OR description IS NULL OR when_to_use IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'update_order_fulfillment: % catalog row(s) corrected', n;
END $$;

-- Report the resulting text so a run leaves evidence.
DO $$
DECLARE d TEXT;
BEGIN
  SELECT description INTO d FROM catalog_tools WHERE slug = 'update_order_fulfillment';
  RAISE NOTICE 'AFTER: %', coalesce(left(d, 100), '(no such tool in this catalog)');
END $$;

COMMIT;
