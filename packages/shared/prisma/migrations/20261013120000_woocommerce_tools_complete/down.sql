-- Inverse of migration.sql: the grants and tenant tools of the 15 new
-- WooCommerce tools, then the tools themselves (also any write a person
-- provisioned since, by setting its policy); create_coupon's text back.
DELETE FROM "agent_tool_permissions" WHERE "tenant_tool_id" IN (
  SELECT tt.id FROM "tenant_tools" tt JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
  WHERE ct."integration_id" = 'cat_woocommerce' AND ct."id" LIKE 'tool_woocommerce_%'
    AND ct."slug" IN ('list_order_notes','add_order_note','list_refunds','create_refund','cancel_order','update_shipping_address','update_customer','create_customer','get_product','list_product_variations','list_coupons','get_coupon','disable_coupon','list_customer_orders','get_shipment_tracking'));
DELETE FROM "tenant_tools" WHERE "catalog_tool_id" IN (
  SELECT id FROM "catalog_tools" WHERE "integration_id" = 'cat_woocommerce'
    AND "slug" IN ('list_order_notes','add_order_note','list_refunds','create_refund','cancel_order','update_shipping_address','update_customer','create_customer','get_product','list_product_variations','list_coupons','get_coupon','disable_coupon','list_customer_orders','get_shipment_tracking'));
DELETE FROM "catalog_tools" WHERE "integration_id" = 'cat_woocommerce'
  AND "slug" IN ('list_order_notes','add_order_note','list_refunds','create_refund','cancel_order','update_shipping_address','update_customer','create_customer','get_product','list_product_variations','list_coupons','get_coupon','disable_coupon','list_customer_orders','get_shipment_tracking');
UPDATE "catalog_tools" SET "description" = 'Create a percentage-off discount coupon.' WHERE "integration_id" = 'cat_woocommerce' AND "slug" = 'create_coupon';
