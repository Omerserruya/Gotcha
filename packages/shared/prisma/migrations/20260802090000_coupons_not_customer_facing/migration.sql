-- Coupons and discounts are out of scope for CUSTOMER conversations.
--
-- Product decision, not a defect. A customer asking "יש קופון?" should get a
-- plain answer, not a discount-code mutation, and certainly not a human
-- approval request for money off. The live failure that prompted this was a
-- garbled reply that simultaneously offered to create a coupon, promised to
-- pass the details to a team, and speculated about booking a meeting.
--
-- `allowed_modes` is the existing lever and it already means exactly this:
--   AUTO   - the autonomous customer-facing AI
--   ASSIST - copilot and human agent
--
-- Dropping AUTO removes these from BOTH customer tool surfaces (the
-- `integration_<slug>` catalog path and the `<provider>.<tool>` adapter path,
-- which both honour this field) while leaving them fully available to a human
-- agent who decides to give someone a discount. That is where the decision
-- belongs.
UPDATE "catalog_tools" ct
SET "allowed_modes" = '["ASSIST"]'::jsonb
FROM "integration_catalog" ic
WHERE ic.id = ct."integration_id"
  AND ic.slug = 'shopify'
  AND ct.slug IN (
    'validate_discount',
    'list_discounts',
    'get_customer_discounts',
    'create_discount_code',
    'create_one_time_coupon',
    'create_vip_coupon',
    'disable_coupon',
    'issue_compensation_coupon'
  );
