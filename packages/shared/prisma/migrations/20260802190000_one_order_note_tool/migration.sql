-- Two tools wrote a note and a tag onto an order, and neither was the one the
-- model reached for.
--
-- `update_order_fulfillment` was declared for years, implemented late, and is
-- named after something it does not do. `add_order_note` was added one
-- migration ago and does the same write with a read-back afterwards. Leaving
-- both on the autonomous surface is how scenario 26 happened: asked to record
-- a callback request the model picked `create_note`, which writes the CUSTOMER
-- profile, so a note really was saved, the honesty check saw a successful
-- write, and the ORDER still read note: null. A true claim about the wrong
-- object is harder to catch than a false one - every guard we had was
-- satisfied.
--
-- So the customer surface gets exactly one tool for this. ASSIST keeps
-- `update_order_fulfillment` for human agents and for anything already wired
-- to it; AUTO no longer sees a choice it kept getting wrong.
UPDATE "catalog_tools" ct
SET "allowed_modes" = '["ASSIST"]'::jsonb
FROM "integration_catalog" ic
WHERE ic.id = ct."integration_id"
  AND ic.slug = 'shopify'
  AND ct.slug = 'update_order_fulfillment';
