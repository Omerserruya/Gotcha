-- ReturnGO integration: returns/RMA platform (API-key auth).
-- Catalog-driven, so the marketplace + generic API_KEY connect flow pick it up
-- with no frontend changes. Idempotent where it matters.

-- ── Catalog entry ──
INSERT INTO "integration_catalog"
  ("id", "slug", "name", "description", "category", "auth_type", "auth_schema", "is_published", "sort_order", "created_at", "updated_at")
VALUES
  ('cat_returngo', 'returngo', 'ReturnGO',
   'Returns & RMA management platform — refund/return transaction status and updates.',
   'ECOMMERCE', 'API_KEY',
   '{"fields":[{"key":"apiKey","label":"API Key","type":"password","required":true,"helpText":"ReturnGO → Settings → Integrations → API."},{"key":"shopName","label":"Store Domain","type":"text","required":true,"placeholder":"my-store.myshopify.com","helpText":"Your store domain. Multi-portal stores use my-store.myshopify.com@PortalName."}]}',
   true, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- ── Tools ──
-- READ tools are default-enabled on connect; the WRITE/HIGH tool is opt-in.
INSERT INTO "catalog_tools"
  ("id", "integration_id", "slug", "name", "description", "when_to_use", "category", "risk_level", "is_default", "sort_order", "method", "created_at")
VALUES
  ('tool_returngo_get_transactions', 'cat_returngo', 'get_transactions', 'Get Transactions',
   'List ReturnGO transactions (refunds, payment auth/capture, invoice payments) for an order or customer.',
   'Customer asks about their refund/return transaction status and the store runs returns through ReturnGO.',
   'READ', 'LOW', true, 1, 'GET', CURRENT_TIMESTAMP),
  ('tool_returngo_get_return_status', 'cat_returngo', 'get_return_status', 'Get Return Status',
   'Summarize the latest return/refund transaction status for an order from ReturnGO.',
   'Customer asks "what is the status of my return/refund?" and ReturnGO is the returns platform.',
   'READ', 'LOW', true, 2, 'GET', CURRENT_TIMESTAMP),
  ('tool_returngo_update_transaction', 'cat_returngo', 'update_transaction', 'Update Transaction',
   'Update a ReturnGO transaction (e.g. refund/payment status) by transaction id.',
   'You have approval to change a return transaction status in ReturnGO.',
   'WRITE', 'HIGH', false, 3, 'PUT', CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
