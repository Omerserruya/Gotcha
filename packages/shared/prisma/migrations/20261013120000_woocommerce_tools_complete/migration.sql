-- WooCommerce: every missing tool (Omer, 2026-10-13: "everything that's
-- missing"). The adapter (services/ai woocommerce.adapter.ts) implements them;
-- these are their catalogue rows. Customer-channel calls go through the
-- cross-customer guard (PROTECTED_WOO_TOOLS + the order ownership pre-fetch).
--
-- Writes default to Ask (hitl always). READ tools are provisioned and granted
-- on stores already connected; WRITE tools are provisioned only when someone
-- sets their policy (the PUT does that), as connecting does today.
-- Inverse: down.sql.

INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_woocommerce_list_order_notes',        'list_order_notes',        'cat_woocommerce', 'Order Notes',            'The notes on an order: what the store and the customer wrote, and system notes.', 'READ',  'LOW',    true, 8,  'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_add_order_note',          'add_order_note',          'cat_woocommerce', 'Add Order Note',         'Add a note to an order; a customer-visible note is emailed to the customer.',     'WRITE', 'MEDIUM', true, 9,  'POST', CURRENT_TIMESTAMP),
('tool_woocommerce_list_refunds',            'list_refunds',            'cat_woocommerce', 'Order Refunds',          'The refunds already made on an order, with amounts and reasons.',                 'READ',  'LOW',    true, 10, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_create_refund',           'create_refund',           'cat_woocommerce', 'Refund Order',           'Refund an order, fully or partly, through the store''s payment gateway.',          'WRITE', 'HIGH',   true, 11, 'POST', CURRENT_TIMESTAMP),
('tool_woocommerce_cancel_order',            'cancel_order',            'cat_woocommerce', 'Cancel Order',           'Cancel an order that has not been fulfilled.',                                    'WRITE', 'HIGH',   true, 12, 'PUT',  CURRENT_TIMESTAMP),
('tool_woocommerce_update_shipping_address', 'update_shipping_address', 'cat_woocommerce', 'Update Shipping Address','Change the shipping address of an order that has not shipped.',                   'WRITE', 'MEDIUM', true, 13, 'PUT',  CURRENT_TIMESTAMP),
('tool_woocommerce_update_customer',         'update_customer',         'cat_woocommerce', 'Update Customer',        'Update a customer''s name, email or phone.',                                      'WRITE', 'MEDIUM', true, 14, 'PUT',  CURRENT_TIMESTAMP),
('tool_woocommerce_create_customer',         'create_customer',         'cat_woocommerce', 'Create Customer',        'Create a customer account in the store.',                                         'WRITE', 'MEDIUM', true, 15, 'POST', CURRENT_TIMESTAMP),
('tool_woocommerce_get_product',             'get_product',             'cat_woocommerce', 'Get Product',            'One product with its price and stock.',                                           'READ',  'LOW',    true, 16, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_list_product_variations', 'list_product_variations', 'cat_woocommerce', 'Product Variations',     'The variations of a product with price and stock for each.',                      'READ',  'LOW',    true, 17, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_list_coupons',            'list_coupons',            'cat_woocommerce', 'List Coupons',           'The store''s coupons.',                                                           'READ',  'LOW',    true, 18, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_get_coupon',              'get_coupon',              'cat_woocommerce', 'Check Coupon',           'Whether a coupon code exists and is still valid, and what it gives.',             'READ',  'LOW',    true, 19, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_disable_coupon',          'disable_coupon',          'cat_woocommerce', 'Disable Coupon',         'Stop a coupon from being used.',                                                  'WRITE', 'MEDIUM', true, 20, 'PUT',  CURRENT_TIMESTAMP),
('tool_woocommerce_list_customer_orders',    'list_customer_orders',    'cat_woocommerce', 'Customer Orders',        'A customer''s orders, newest first.',                                             'READ',  'LOW',    true, 21, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_get_shipment_tracking',   'get_shipment_tracking',   'cat_woocommerce', 'Shipment Tracking',      'Tracking numbers and links for an order (Shipment Tracking extension).',          'READ',  'LOW',    true, 22, 'GET',  CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id","slug") DO NOTHING;

UPDATE "catalog_tools" SET "description" = 'Create a discount coupon: a percentage off, or a fixed amount off the cart.'
WHERE "integration_id" = 'cat_woocommerce' AND "slug" = 'create_coupon';

-- Writes ask by default.
UPDATE "catalog_tools"
SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
WHERE "integration_id" = 'cat_woocommerce'
  AND "slug" IN ('add_order_note','create_refund','cancel_order','update_shipping_address','update_customer','create_customer','disable_coupon');

-- Reads run without asking, provisioned on connected stores.
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"never"}'
WHERE "integration_id" = 'cat_woocommerce'
  AND "slug" IN ('list_order_notes','list_refunds','get_product','list_product_variations','list_coupons','get_coupon','list_customer_orders','get_shipment_tracking');

INSERT INTO "tenant_tools" (id, tenant_id, tenant_integration_id, catalog_tool_id, is_enabled, config_overrides, created_at, updated_at)
SELECT 'tt_' || substr(md5(ti.id || ct.id), 1, 24), ti."tenant_id", ti.id, ct.id, true, '{}'::jsonb, now(), now()
FROM "tenant_integrations" ti
JOIN "catalog_tools" ct ON ct."integration_id" = ti."integration_id"
WHERE ti."integration_id" = 'cat_woocommerce' AND ti.status = 'CONNECTED'
  AND ct."slug" IN ('list_order_notes','list_refunds','get_product','list_product_variations','list_coupons','get_coupon','list_customer_orders','get_shipment_tracking')
ON CONFLICT ("tenant_integration_id","catalog_tool_id") DO NOTHING;

INSERT INTO "agent_tool_permissions" (id, tenant_id, ai_agent_id, tenant_tool_id, is_allowed, require_approval, created_at, updated_at)
SELECT 'atp_' || substr(md5(a.id || tt.id), 1, 24), tt."tenant_id", a.id, tt.id, true, false, now(), now()
FROM "tenant_tools" tt
JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
JOIN "ai_agents" a ON a."tenant_id" = tt."tenant_id"
WHERE ct."integration_id" = 'cat_woocommerce'
  AND ct."slug" IN ('list_order_notes','list_refunds','get_product','list_product_variations','list_coupons','get_coupon','list_customer_orders','get_shipment_tracking')
  AND NOT EXISTS (SELECT 1 FROM "agent_tool_permissions" x WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id);
