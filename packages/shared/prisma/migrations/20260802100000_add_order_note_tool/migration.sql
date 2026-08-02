-- A tool for notes on the ORDER.
--
-- There wasn't one. Asked to "write it on order #1011" the model reached for
-- `create_note`, which writes the CUSTOMER profile - so a note really was
-- saved, the honesty check saw a successful write and allowed "ההערה נוספה
-- להזמנה 1011", and Shopify's order still read note: null.
--
-- A true claim about the wrong object is harder to catch than a false one:
-- every guard we have was satisfied.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
)
SELECT
  'ctool_add_order_note', ic.id, 'add_order_note', 'Add order note',
  'Add a note and/or tags to a specific ORDER, then verify it was applied.',
  'WRITE',
  '{"type":"object","properties":{"order_id":{"type":"string"},"order_name":{"type":"string"},"note":{"type":"string"},"tags":{"type":"string"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'PUT', false, 'LOW', 500, now(),
  'Customer asks you to write something on their order. A note RECORDS information on the order - it does not notify anyone and is not a task.',
  '["AUTO","ASSIST"]'::jsonb, 1
FROM "integration_catalog" ic
WHERE ic.slug = 'shopify'
  AND NOT EXISTS (SELECT 1 FROM "catalog_tools" x WHERE x.integration_id = ic.id AND x.slug = 'add_order_note');
