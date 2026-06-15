-- ============================================================
-- Marketplace cleanup: keep ONLY integrations with real adapters.
--
-- This migration:
--   1) Drops catalog entries with no working adapter (BigCommerce,
--      Magento, ShipStation, AfterShip, Shippo, Easyship, Pipedrive,
--      Zendesk, Intercom, Slack, Google Analytics, mongo_atlas).
--   2) Refreshes catalog_tools to match the adapter tool surface
--      (so what the marketplace UI shows is what the LLM actually sees).
--   3) Adds Airtable to the catalog (adapter ships in services/ai/src/services/connectors/airtable.adapter.ts).
--   4) Updates auth_schema for OAuth providers + the API-key shapes
--      adapters expect (woocommerce: store_url + consumer_key/secret;
--      paypal: client_id/secret + environment; aws_rds: connection_string).
-- ============================================================

-- ─── 1) Drop catalog entries without working adapters ─────────
-- ON DELETE CASCADE on catalog_tools/tenant_integrations handles the rest.

DELETE FROM "integration_catalog" WHERE "slug" IN (
  'bigcommerce', 'magento',
  'shippo', 'easyship', 'shipstation', 'aftership',
  'pipedrive', 'zendesk', 'intercom',
  'slack', 'google_analytics',
  'mongo_atlas'
);

-- ─── 2) Refresh catalog_tools for live integrations ───────────

-- Wipe existing tool rows for integrations we're respeccing. Tenant
-- tool selections rebuild from defaults on next connect; existing
-- tenants get an automatic re-seed via the bot's adapter discovery path.
DELETE FROM "catalog_tools" WHERE "integration_id" IN (
  'cat_shopify', 'cat_woocommerce', 'cat_wix',
  'cat_stripe', 'cat_paypal', 'cat_square',
  'cat_hubspot', 'cat_salesforce', 'cat_monday',
  'cat_postgresql', 'cat_mongodb', 'cat_aws_rds'
);

-- Shopify (slugs match shopify.adapter.ts → "shopify.<slug>")
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_shopify_get_orders',                'get_orders',                'cat_shopify', 'List Orders',         'List recent Shopify orders, optionally filtered by status / customer.', 'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_get_order',                 'get_order',                 'cat_shopify', 'Get Order',           'Retrieve a single Shopify order by id or order number.',                'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_get_customer',              'get_customer',              'cat_shopify', 'Get Customer',        'Get a Shopify customer by id or email.',                                'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_search_customers',          'search_customers',          'cat_shopify', 'Search Customers',    'Search Shopify customers by email/phone/name fragment.',                'READ',  'LOW',    true, 4, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_create_discount_code',      'create_discount_code',      'cat_shopify', 'Create Discount',     'Create a percentage-off discount code with a usage limit.',             'WRITE', 'HIGH',   true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_shopify_update_order_fulfillment',  'update_order_fulfillment',  'cat_shopify', 'Tag/Note Order',      'Add a note + tag to an order (non-destructive ops handoff).',           'WRITE', 'LOW',    true, 6, 'PUT',  CURRENT_TIMESTAMP);

-- WooCommerce
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_woocommerce_list_orders',          'list_orders',          'cat_woocommerce', 'List Orders',          'List recent WooCommerce orders, filterable by status or email.',         'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_get_order',            'get_order',            'cat_woocommerce', 'Get Order',            'Get one WooCommerce order by id.',                                       'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_update_order_status',  'update_order_status',  'cat_woocommerce', 'Update Order Status',  'Change the status of an existing order.',                                'WRITE', 'HIGH',   true, 3, 'PUT',  CURRENT_TIMESTAMP),
('tool_woocommerce_get_customer',         'get_customer',         'cat_woocommerce', 'Get Customer',         'Get a customer by id or email.',                                         'READ',  'LOW',    true, 4, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_search_customers',     'search_customers',     'cat_woocommerce', 'Search Customers',     'Search customers by partial email/name.',                                'READ',  'LOW',    true, 5, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_list_products',        'list_products',        'cat_woocommerce', 'List Products',        'Search WooCommerce products by name/SKU.',                               'READ',  'LOW',    true, 6, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_create_coupon',        'create_coupon',        'cat_woocommerce', 'Create Coupon',        'Create a percentage-off discount coupon.',                               'WRITE', 'HIGH',   true, 7, 'POST', CURRENT_TIMESTAMP);

-- Wix
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_wix_list_orders',     'list_orders',     'cat_wix', 'List Orders',     'List recent Wix Stores orders.',                                'READ',  'LOW', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_wix_get_order',       'get_order',       'cat_wix', 'Get Order',       'Retrieve one Wix Stores order by id.',                          'READ',  'LOW', true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_wix_list_products',   'list_products',   'cat_wix', 'List Products',   'List/search Wix Stores products by name fragment.',             'READ',  'LOW', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_wix_get_product',     'get_product',     'cat_wix', 'Get Product',     'Get one Wix Stores product by id.',                             'READ',  'LOW', true, 4, 'GET',  CURRENT_TIMESTAMP),
('tool_wix_search_contacts', 'search_contacts', 'cat_wix', 'Search Contacts', 'Search Wix CRM contacts by email/phone/name.',                  'READ',  'LOW', true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_wix_create_contact',  'create_contact',  'cat_wix', 'Create Contact',  'Create a Wix CRM contact (idempotent on email).',               'WRITE', 'LOW', true, 6, 'POST', CURRENT_TIMESTAMP);

-- Stripe
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_stripe_create_payment_link', 'create_payment_link', 'cat_stripe', 'Create Payment Link', 'Create a Stripe Payment Link returning a hosted checkout URL.',     'WRITE', 'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_stripe_refund_payment',      'refund_payment',      'cat_stripe', 'Refund Payment',      'Refund a Stripe charge or PaymentIntent (full or partial).',        'WRITE', 'HIGH',   true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_stripe_get_customer',        'get_customer',        'cat_stripe', 'Get Customer',        'Look up a Stripe Customer by id or email.',                         'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_stripe_list_transactions',   'list_transactions',   'cat_stripe', 'List Transactions',   'List a customer''s recent successful charges.',                     'READ',  'LOW',    true, 4, 'GET',  CURRENT_TIMESTAMP),
('tool_stripe_create_invoice',      'create_invoice',      'cat_stripe', 'Create Invoice',      'Create + finalize an invoice for a customer.',                       'WRITE', 'MEDIUM', true, 5, 'POST', CURRENT_TIMESTAMP);

-- PayPal
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_paypal_create_invoice',       'create_invoice',       'cat_paypal', 'Create Invoice',       'Create a PayPal invoice and send it to the customer.',                     'WRITE', 'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_paypal_refund_capture',       'refund_capture',       'cat_paypal', 'Refund Capture',       'Refund a captured PayPal payment (full or partial).',                      'WRITE', 'HIGH',   true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_paypal_get_order',            'get_order',            'cat_paypal', 'Get Order',            'Retrieve a PayPal order by id (v2 Orders API).',                            'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_paypal_list_transactions',    'list_transactions',    'cat_paypal', 'List Transactions',    'List recent PayPal transactions in a date range.',                          'READ',  'LOW',    true, 4, 'GET',  CURRENT_TIMESTAMP),
('tool_paypal_create_payment_link',  'create_payment_link',  'cat_paypal', 'Create Payment Link',  'Create a checkout order and return the customer-approval URL.',             'WRITE', 'MEDIUM', true, 5, 'POST', CURRENT_TIMESTAMP);

-- Square
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_square_search_customers',    'search_customers',    'cat_square', 'Search Customers',    'Search Square customers by email/phone/name.',                              'READ',  'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_square_create_customer',     'create_customer',     'cat_square', 'Create Customer',     'Create a Square customer record.',                                          'WRITE', 'LOW',    true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_square_list_payments',       'list_payments',       'cat_square', 'List Payments',       'List recent Square payments.',                                              'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_square_refund_payment',      'refund_payment',      'cat_square', 'Refund Payment',      'Refund a Square payment (full or partial).',                                'WRITE', 'HIGH',   true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_square_create_payment_link', 'create_payment_link', 'cat_square', 'Create Payment Link', 'Create a Square Checkout Payment Link.',                                    'WRITE', 'MEDIUM', true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_square_list_orders',         'list_orders',         'cat_square', 'List Orders',         'List recent Square orders for the configured location.',                    'READ',  'LOW',    true, 6, 'POST', CURRENT_TIMESTAMP);

-- HubSpot
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_hubspot_create_contact',  'create_contact',  'cat_hubspot', 'Create/Upsert Contact', 'Create or upsert a HubSpot contact by email.',           'WRITE', 'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_hubspot_update_contact',  'update_contact',  'cat_hubspot', 'Update Contact',        'Patch properties on an existing HubSpot contact.',       'WRITE', 'LOW',    true, 2, 'PATCH',CURRENT_TIMESTAMP),
('tool_hubspot_get_contact',     'get_contact',     'cat_hubspot', 'Get Contact',           'Read a HubSpot contact by id or email.',                 'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_hubspot_search_contacts', 'search_contacts', 'cat_hubspot', 'Search Contacts',       'Search HubSpot contacts by partial email/phone/name.',   'READ',  'LOW',    true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_hubspot_log_activity',    'log_activity',    'cat_hubspot', 'Log Activity',          'Log a note/email/call engagement against a contact.',    'WRITE', 'LOW',    true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_hubspot_create_deal',     'create_deal',     'cat_hubspot', 'Create Deal',           'Open a new deal in a HubSpot pipeline.',                 'WRITE', 'MEDIUM', true, 6, 'POST', CURRENT_TIMESTAMP);

-- Salesforce
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_salesforce_search_records', 'search_records', 'cat_salesforce', 'Search Records',  'Search Salesforce records via SOSL across one sObject.', 'READ',  'LOW',    true, 1, 'GET',   CURRENT_TIMESTAMP),
('tool_salesforce_get_record',     'get_record',     'cat_salesforce', 'Get Record',      'Get a Salesforce sObject by Id.',                        'READ',  'LOW',    true, 2, 'GET',   CURRENT_TIMESTAMP),
('tool_salesforce_create_lead',    'create_lead',    'cat_salesforce', 'Create Lead',     'Create a Salesforce Lead.',                              'WRITE', 'MEDIUM', true, 3, 'POST',  CURRENT_TIMESTAMP),
('tool_salesforce_update_lead',    'update_lead',    'cat_salesforce', 'Update Lead',     'Patch fields on a Salesforce Lead.',                     'WRITE', 'LOW',    true, 4, 'PATCH', CURRENT_TIMESTAMP),
('tool_salesforce_create_case',    'create_case',    'cat_salesforce', 'Create Case',     'Open a Salesforce Service Cloud Case.',                  'WRITE', 'MEDIUM', true, 5, 'POST',  CURRENT_TIMESTAMP),
('tool_salesforce_log_task',       'log_task',       'cat_salesforce', 'Log Task',        'Log a Task on a record (call/email/note).',              'WRITE', 'LOW',    true, 6, 'POST',  CURRENT_TIMESTAMP);

-- Monday.com
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_monday_list_boards',         'list_boards',         'cat_monday', 'List Boards',          'List Monday.com boards visible to the connected user.',  'READ',  'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_monday_list_items',          'list_items',          'cat_monday', 'List Items',           'List items on a board (paginated).',                     'READ',  'LOW',    true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_monday_get_item',            'get_item',            'cat_monday', 'Get Item',             'Get one Monday item with all column values.',            'READ',  'LOW',    true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_monday_create_item',         'create_item',         'cat_monday', 'Create Item',          'Create a new item on a Monday board.',                   'WRITE', 'MEDIUM', true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_monday_update_item_column',  'update_item_column',  'cat_monday', 'Update Item Column',   'Update one column on a Monday item.',                    'WRITE', 'LOW',    true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_monday_add_item_update',     'add_item_update',     'cat_monday', 'Add Item Update',      'Add a comment/update to a Monday item.',                 'WRITE', 'LOW',    true, 6, 'POST', CURRENT_TIMESTAMP);

-- PostgreSQL
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_postgres_query_table', 'query_table', 'cat_postgresql', 'Query Table',  'SELECT rows from a whitelisted table with optional equality filters.', 'READ',  'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_postgres_get_row',     'get_row',     'cat_postgresql', 'Get Row',      'Fetch a single row by primary-key column = value.',                    'READ',  'LOW',    true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_postgres_insert_row',  'insert_row',  'cat_postgresql', 'Insert Row',   'Insert one row into a whitelisted-for-write table.',                   'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_postgres_update_row',  'update_row',  'cat_postgresql', 'Update Row',   'Update one row by primary key on a whitelisted-for-write table.',      'WRITE', 'MEDIUM', true, 4, 'POST', CURRENT_TIMESTAMP);

-- MongoDB
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_mongo_find_documents',  'find_documents',  'cat_mongodb', 'Find Documents',  'Query documents from a whitelisted collection.',           'READ',  'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_get_document',    'get_document',    'cat_mongodb', 'Get Document',    'Fetch a document by _id.',                                 'READ',  'LOW',    true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_insert_document', 'insert_document', 'cat_mongodb', 'Insert Document', 'Insert one document into a writable collection.',          'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_update_document', 'update_document', 'cat_mongodb', 'Update Document', 'Update one document by _id with $set.',                    'WRITE', 'MEDIUM', true, 4, 'POST', CURRENT_TIMESTAMP);

-- AWS RDS
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_aws_rds_query_table', 'query_table', 'cat_aws_rds', 'Query Table',  'SELECT rows from a whitelisted RDS table.',         'READ',  'LOW',    true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_aws_rds_get_row',     'get_row',     'cat_aws_rds', 'Get Row',      'Fetch a single row by primary key.',                'READ',  'LOW',    true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_aws_rds_insert_row',  'insert_row',  'cat_aws_rds', 'Insert Row',   'Insert one row into a writable RDS table.',         'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_aws_rds_update_row',  'update_row',  'cat_aws_rds', 'Update Row',   'Update one row by primary key on an RDS table.',    'WRITE', 'MEDIUM', true, 4, 'POST', CURRENT_TIMESTAMP);

-- ─── 3) Add Airtable to the catalog ───────────────────────────

INSERT INTO "integration_catalog" ("id", "slug", "name", "description", "category", "auth_type", "auth_schema", "config_schema", "is_published", "sort_order", "created_at", "updated_at")
VALUES (
  'cat_airtable',
  'airtable',
  'Airtable',
  'Connect an Airtable base + table for read/write access from the AI agent.',
  'DATABASE',
  'API_KEY',
  '{"required":["apiKey"],"fields":[{"key":"apiKey","label":"Personal Access Token","type":"password","required":true,"helpText":"Generate at https://airtable.com/create/tokens with scopes: data.records:read, data.records:write, schema.bases:read"}]}',
  '{"required":["baseId","tableId"],"fields":[{"key":"baseId","label":"Base","type":"select","helpText":"Loaded from /connectors/airtable/meta/bases"},{"key":"tableId","label":"Table","type":"select","helpText":"Loaded from /connectors/airtable/meta/tables/:baseId"}]}',
  true,
  29,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "auth_type" = EXCLUDED."auth_type",
  "auth_schema" = EXCLUDED."auth_schema",
  "config_schema" = EXCLUDED."config_schema",
  "is_published" = true,
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_airtable_list_records',  'list_records',  'cat_airtable', 'List Records',  'List records from the configured table (filterByFormula optional).', 'READ',  'LOW',    true, 1, 'GET',   CURRENT_TIMESTAMP),
('tool_airtable_get_record',    'get_record',    'cat_airtable', 'Get Record',    'Get a single Airtable record by id.',                                'READ',  'LOW',    true, 2, 'GET',   CURRENT_TIMESTAMP),
('tool_airtable_create_record', 'create_record', 'cat_airtable', 'Create Record', 'Create a single record in the configured table.',                    'WRITE', 'MEDIUM', true, 3, 'POST',  CURRENT_TIMESTAMP),
('tool_airtable_update_record', 'update_record', 'cat_airtable', 'Update Record', 'Patch fields on an existing Airtable record.',                       'WRITE', 'LOW',    true, 4, 'PATCH', CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;

-- ─── 4) Refresh auth_schema + auth_type for live integrations ─

-- Stripe - OAuth (Connect) preferred, API key fallback
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[],"helpText":"Connect via Stripe OAuth (Connect). Tenants without a Connect account can paste a restricted API key as a fallback."}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'stripe';

-- HubSpot - OAuth
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[],"scopes":["crm.objects.contacts.read","crm.objects.contacts.write","crm.objects.deals.read","crm.objects.deals.write"]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'hubspot';

-- Shopify - per-shop OAuth
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[{"key":"shop","label":"Shop domain","type":"text","required":true,"placeholder":"my-store.myshopify.com"}],"scopes":["read_orders","write_orders","read_customers","write_discounts","read_products"]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'shopify';

-- WooCommerce - store URL + consumer key/secret
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"required":["storeUrl","consumerKey","consumerSecret"],"fields":[{"key":"storeUrl","label":"Store URL","type":"url","required":true,"placeholder":"https://shop.example.com"},{"key":"consumerKey","label":"Consumer Key","type":"password","required":true},{"key":"consumerSecret","label":"Consumer Secret","type":"password","required":true}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'woocommerce';

-- Wix - OAuth (Headless)
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[],"helpText":"Connects via Wix Headless OAuth. Refresh tokens are issued at install time."}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'wix';

-- PayPal - app-level credentials (client_credentials grant)
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"required":["clientId","clientSecret","environment"],"fields":[{"key":"clientId","label":"Client ID","type":"password","required":true},{"key":"clientSecret","label":"Client Secret","type":"password","required":true},{"key":"environment","label":"Environment","type":"select","required":true,"options":["live","sandbox"]}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'paypal';

-- Square - OAuth (production/sandbox toggle in config)
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[{"key":"environment","label":"Environment","type":"select","required":true,"options":["production","sandbox"],"default":"production"}],"scopes":["PAYMENTS_WRITE","PAYMENTS_READ","CUSTOMERS_READ","CUSTOMERS_WRITE","ORDERS_READ","ORDERS_WRITE","INVOICES_READ","INVOICES_WRITE","MERCHANT_PROFILE_READ"]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'square';

-- Salesforce - OAuth (Web Server flow)
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[{"key":"loginHost","label":"Login Host","type":"select","required":true,"options":["https://login.salesforce.com","https://test.salesforce.com"],"default":"https://login.salesforce.com","helpText":"Use test.salesforce.com for sandbox orgs."}],"scopes":["api","refresh_token","offline_access"]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'salesforce';

-- Monday.com - OAuth
UPDATE "integration_catalog" SET
  "auth_type" = 'OAUTH2',
  "auth_schema" = '{"oauth":true,"fields":[],"scopes":["boards:read","boards:write","updates:write"]}',
  "config_schema" = '{"fields":[{"key":"defaultBoardId","label":"Default Board","type":"select","helpText":"Loaded from /connectors/monday/meta/boards after connect"}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'monday';

-- PostgreSQL - connection string + table allowlist
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"required":["connectionString"],"fields":[{"key":"connectionString","label":"Connection String","type":"password","required":true,"placeholder":"postgres://user:pass@host:5432/dbname"}]}',
  "config_schema" = '{"fields":[{"key":"allowReads","label":"Tables AI may read","type":"text-list","required":true},{"key":"allowWrites","label":"Tables AI may write","type":"text-list"},{"key":"maxRows","label":"Max rows per query","type":"number","default":100},{"key":"readOnlySearchPath","label":"search_path (optional)","type":"text"}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'postgresql';

-- MongoDB - connection string + collection allowlist
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"required":["connectionString"],"fields":[{"key":"connectionString","label":"Connection String","type":"password","required":true,"placeholder":"mongodb+srv://user:pass@cluster.mongodb.net"}]}',
  "config_schema" = '{"required":["dbName"],"fields":[{"key":"dbName","label":"Database Name","type":"text","required":true},{"key":"allowReads","label":"Collections AI may read","type":"text-list","required":true},{"key":"allowWrites","label":"Collections AI may write","type":"text-list"},{"key":"maxDocs","label":"Max docs per query","type":"number","default":100}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'mongodb';

-- AWS RDS - connection string + engine + table allowlist
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"required":["connectionString"],"fields":[{"key":"connectionString","label":"Connection String","type":"password","required":true,"placeholder":"postgres://user:pass@instance.xyz.rds.amazonaws.com:5432/dbname"}]}',
  "config_schema" = '{"required":["engine"],"fields":[{"key":"engine","label":"Engine","type":"select","required":true,"options":["postgres","mysql","mariadb"],"default":"postgres"},{"key":"allowReads","label":"Tables AI may read","type":"text-list","required":true},{"key":"allowWrites","label":"Tables AI may write","type":"text-list"},{"key":"maxRows","label":"Max rows per query","type":"number","default":100}]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'aws_rds';

-- Custom API - already correct, but tighten the schema messaging
UPDATE "integration_catalog" SET
  "auth_type" = 'API_KEY',
  "auth_schema" = '{"fields":[{"key":"baseUrl","label":"Base URL (informational)","type":"url","required":false,"helpText":"Default base URL - each tool defines its own URL template."}]}',
  "description" = 'Define your own AI tool from any HTTP API. Each tool gets a name, description, when-to-use, parameters, and a URL template.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'custom_api';

-- ─── 5) HITL policies for HIGH-risk catalog tools ─────────────
--
-- Tenants can override these via TenantTool.configOverrides.hitlPolicy at any
-- time, but the catalog default for irreversible / financial actions is
-- "always require approval". Catalog tools default to {"mode":"never"} per
-- the schema column default - without this seed, a HIGH-risk refund or
-- discount would execute without HITL on a freshly-connected integration.

-- All refund tools (stripe / paypal / square)
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":false}'
  WHERE "slug" IN ('refund_payment', 'refund_capture');

-- All discount/coupon issuance
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
  WHERE "slug" IN ('create_discount_code', 'create_coupon');

-- Order status mutations (cancel/complete an order is customer-visible)
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"on_condition","condition":"args.status == \"cancelled\" || args.status == \"refunded\"","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60}'
  WHERE "slug" = 'update_order_status';

-- Invoice creation (charges customer)
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":120,"allowModification":true}'
  WHERE "slug" IN ('create_invoice', 'create_payment_link');

-- DB writes (Postgres / Mongo / RDS) - INSERT defaults to allow (allowlist
-- already gates table access), UPDATE/DELETE require approval.
UPDATE "catalog_tools" SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":30}'
  WHERE "slug" IN ('update_row', 'update_document');
