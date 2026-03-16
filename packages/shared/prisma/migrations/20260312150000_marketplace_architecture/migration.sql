-- ============================================================
-- Migration: marketplace_architecture
-- Replaces old tool/integration tables with catalog-based
-- marketplace architecture.
-- ============================================================

-- ─── Drop old tables (FK order) ─────────────────────────────
ALTER TABLE "tool_executions" DROP CONSTRAINT IF EXISTS "tool_executions_tool_id_fkey";
ALTER TABLE "department_tool_permissions" DROP CONSTRAINT IF EXISTS "department_tool_permissions_tool_id_fkey";
ALTER TABLE "department_tool_permissions" DROP CONSTRAINT IF EXISTS "department_tool_permissions_department_id_fkey";
ALTER TABLE "tool_definitions" DROP CONSTRAINT IF EXISTS "tool_definitions_integration_id_fkey";

DROP TABLE IF EXISTS "department_tool_permissions";
DROP TABLE IF EXISTS "tool_executions";
DROP TABLE IF EXISTS "tool_definitions";
DROP TABLE IF EXISTS "integrations";

-- ─── Drop old enum ───────────────────────────────────────────
DROP TYPE IF EXISTS "ToolType";

-- ─── Create new enums ────────────────────────────────────────
CREATE TYPE "IntegrationCategory" AS ENUM ('ECOMMERCE', 'CRM', 'PAYMENTS', 'HELPDESK', 'COMMUNICATION', 'ANALYTICS', 'SHIPPING', 'PROJECT_MANAGEMENT', 'CALENDAR', 'DATABASE', 'CUSTOM');
CREATE TYPE "AuthType" AS ENUM ('API_KEY', 'OAUTH2', 'BASIC_AUTH', 'WEBHOOK', 'CUSTOM');
CREATE TYPE "ToolCategory" AS ENUM ('READ', 'WRITE', 'DELETE', 'ACTION');
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'TESTING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- ─── integration_catalog ────────────────────────────────────
CREATE TABLE "integration_catalog" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "long_description" TEXT,
    "category" "IntegrationCategory" NOT NULL,
    "logo_url" TEXT,
    "website" TEXT,
    "docs_url" TEXT,
    "auth_type" "AuthType" NOT NULL,
    "auth_schema" JSONB NOT NULL DEFAULT '{}',
    "config_schema" JSONB NOT NULL DEFAULT '{}',
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_catalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_catalog_slug_key" ON "integration_catalog"("slug");
CREATE INDEX "integration_catalog_category_idx" ON "integration_catalog"("category");
CREATE INDEX "integration_catalog_is_published_idx" ON "integration_catalog"("is_published");

-- ─── catalog_tools ───────────────────────────────────────────
CREATE TABLE "catalog_tools" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ToolCategory" NOT NULL,
    "input_schema" JSONB NOT NULL DEFAULT '{}',
    "output_schema" JSONB NOT NULL DEFAULT '{}',
    "endpoint" TEXT,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_tools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_tools_integration_id_slug_key" ON "catalog_tools"("integration_id", "slug");
CREATE INDEX "catalog_tools_integration_id_idx" ON "catalog_tools"("integration_id");
CREATE INDEX "catalog_tools_category_idx" ON "catalog_tools"("category");

ALTER TABLE "catalog_tools" ADD CONSTRAINT "catalog_tools_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integration_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── tenant_integrations ─────────────────────────────────────
CREATE TABLE "tenant_integrations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "connected_by" TEXT,
    "connected_at" TIMESTAMP(3),
    "last_tested_at" TIMESTAMP(3),
    "last_test_result" BOOLEAN,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_integrations_tenant_id_integration_id_key" ON "tenant_integrations"("tenant_id", "integration_id");
CREATE INDEX "tenant_integrations_tenant_id_idx" ON "tenant_integrations"("tenant_id");
CREATE INDEX "tenant_integrations_integration_id_idx" ON "tenant_integrations"("integration_id");
CREATE INDEX "tenant_integrations_status_idx" ON "tenant_integrations"("status");

ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integration_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── tenant_tools ────────────────────────────────────────────
CREATE TABLE "tenant_tools" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tenant_integration_id" TEXT NOT NULL,
    "catalog_tool_id" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "config_overrides" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_tools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_tools_tenant_integration_id_catalog_tool_id_key" ON "tenant_tools"("tenant_integration_id", "catalog_tool_id");
CREATE INDEX "tenant_tools_tenant_id_idx" ON "tenant_tools"("tenant_id");
CREATE INDEX "tenant_tools_tenant_integration_id_idx" ON "tenant_tools"("tenant_integration_id");
CREATE INDEX "tenant_tools_catalog_tool_id_idx" ON "tenant_tools"("catalog_tool_id");

ALTER TABLE "tenant_tools" ADD CONSTRAINT "tenant_tools_tenant_integration_id_fkey"
    FOREIGN KEY ("tenant_integration_id") REFERENCES "tenant_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_tools" ADD CONSTRAINT "tenant_tools_catalog_tool_id_fkey"
    FOREIGN KEY ("catalog_tool_id") REFERENCES "catalog_tools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── agent_tool_permissions ──────────────────────────────────
CREATE TABLE "agent_tool_permissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "department_id" TEXT,
    "agent_id" TEXT,
    "tenant_tool_id" TEXT NOT NULL,
    "is_allowed" BOOLEAN NOT NULL DEFAULT true,
    "require_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tool_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_tool_permissions_tenant_tool_id_department_id_agent_id_key"
    ON "agent_tool_permissions"("tenant_tool_id", "department_id", "agent_id");
CREATE INDEX "agent_tool_permissions_tenant_id_idx" ON "agent_tool_permissions"("tenant_id");
CREATE INDEX "agent_tool_permissions_department_id_idx" ON "agent_tool_permissions"("department_id");
CREATE INDEX "agent_tool_permissions_tenant_tool_id_idx" ON "agent_tool_permissions"("tenant_tool_id");

ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_tenant_tool_id_fkey"
    FOREIGN KEY ("tenant_tool_id") REFERENCES "tenant_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── tool_executions (new schema) ───────────────────────────
CREATE TABLE "tool_executions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tenant_tool_id" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "success" BOOLEAN NOT NULL DEFAULT true,
    "duration_ms" INTEGER,
    "triggered_by" TEXT NOT NULL DEFAULT 'ai',
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tool_executions_tenant_id_idx" ON "tool_executions"("tenant_id");
CREATE INDEX "tool_executions_conversation_id_idx" ON "tool_executions"("conversation_id");
CREATE INDEX "tool_executions_tenant_tool_id_idx" ON "tool_executions"("tenant_tool_id");
CREATE INDEX "tool_executions_tenant_id_created_at_idx" ON "tool_executions"("tenant_id", "created_at");

ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_tool_id_fkey"
    FOREIGN KEY ("tenant_tool_id") REFERENCES "tenant_tools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- Seed: integration_catalog
-- ============================================================

INSERT INTO "integration_catalog" ("id", "slug", "name", "description", "category", "auth_type", "auth_schema", "is_published", "sort_order", "created_at", "updated_at") VALUES
-- ECOMMERCE
('cat_shopify',          'shopify',          'Shopify',           'E-commerce platform for online stores',             'ECOMMERCE',          'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true,  1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_woocommerce',      'woocommerce',      'WooCommerce',       'Open-source e-commerce plugin for WordPress',       'ECOMMERCE',          'API_KEY', '{"fields":[{"key":"store_url","label":"Store URL","type":"url","required":true},{"key":"consumer_key","label":"Consumer Key","type":"password","required":true},{"key":"consumer_secret","label":"Consumer Secret","type":"password","required":true}]}', true,  2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_bigcommerce',      'bigcommerce',      'BigCommerce',       'Cloud e-commerce platform for fast-growing brands', 'ECOMMERCE',          'API_KEY', '{"fields":[{"key":"store_hash","label":"Store Hash","type":"text","required":true},{"key":"access_token","label":"Access Token","type":"password","required":true}]}',                                                                                       true,  3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_magento',          'magento',          'Magento',           'Open-source e-commerce platform by Adobe',          'ECOMMERCE',          'API_KEY', '{"fields":[{"key":"store_url","label":"Store URL","type":"url","required":true},{"key":"access_token","label":"Access Token","type":"password","required":true}]}',                                                                                         true,  4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_wix',              'wix',              'Wix',               'Cloud-based website and e-commerce builder',        'ECOMMERCE',          'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true,  5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- SHIPPING
('cat_shippo',           'shippo',           'Shippo',            'Multi-carrier shipping and label platform',         'SHIPPING',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true,  6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_easyship',         'easyship',         'Easyship',          'Global shipping and fulfilment platform',           'SHIPPING',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true,  7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_shipstation',      'shipstation',      'ShipStation',       'Order management and shipping automation tool',     'SHIPPING',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true},{"key":"api_secret","label":"API Secret","type":"password","required":true}]}',                                                                                           true,  8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_aftership',        'aftership',        'AfterShip',         'Shipment tracking and notification platform',       'SHIPPING',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true,  9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- PAYMENTS
('cat_stripe',           'stripe',           'Stripe',            'Online payments and billing infrastructure',        'PAYMENTS',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_paypal',           'paypal',           'PayPal',            'Digital payments and money transfer service',       'PAYMENTS',           'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_square',           'square',           'Square',            'Point-of-sale and payment processing platform',     'PAYMENTS',           'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- CRM
('cat_hubspot',          'hubspot',          'HubSpot',           'CRM and marketing automation platform',             'CRM',                'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true, 13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_salesforce',       'salesforce',       'Salesforce',        'Enterprise CRM and sales cloud platform',           'CRM',                'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_pipedrive',        'pipedrive',        'Pipedrive',         'Sales-focused CRM for pipeline management',         'CRM',                'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true, 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_zoho_crm',         'zoho_crm',         'Zoho CRM',          'Cloud-based CRM for sales and customer support',   'CRM',                'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- HELPDESK
('cat_zendesk',          'zendesk',          'Zendesk',           'Customer service and ticketing platform',           'HELPDESK',           'API_KEY', '{"fields":[{"key":"subdomain","label":"Subdomain","type":"text","required":true},{"key":"api_key","label":"API Key","type":"password","required":true},{"key":"email","label":"Email","type":"email","required":true}]}',                                  true, 17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_intercom',         'intercom',         'Intercom',          'Customer messaging and support platform',           'HELPDESK',           'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true, 18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- PROJECT_MANAGEMENT
('cat_monday',           'monday',           'Monday.com',        'Work operating system for project management',      'PROJECT_MANAGEMENT', 'API_KEY', '{"fields":[{"key":"api_key","label":"API Key","type":"password","required":true}]}',                                                                                                                                                                       true, 19, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- CALENDAR
('cat_google_calendar',  'google_calendar',  'Google Calendar',   'Online calendar and scheduling service by Google',  'CALENDAR',           'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_calendly',         'calendly',         'Calendly',          'Automated scheduling and appointment booking tool', 'CALENDAR',           'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 21, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- COMMUNICATION
('cat_slack',            'slack',            'Slack',             'Team communication and collaboration hub',          'COMMUNICATION',      'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- ANALYTICS
('cat_google_analytics', 'google_analytics', 'Google Analytics',  'Web analytics and reporting service',               'ANALYTICS',          'OAUTH2',  '{"fields":[],"oauth":true}',                                                                                                                                                                                                                               true, 23, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- DATABASE
('cat_postgresql',      'postgresql',       'PostgreSQL',        'Open-source relational database with advanced SQL support',         'DATABASE',           'API_KEY', '{"fields":[{"key":"host","label":"Host","type":"text","required":true},{"key":"port","label":"Port","type":"text","required":true},{"key":"database","label":"Database","type":"text","required":true},{"key":"username","label":"Username","type":"text","required":true},{"key":"password","label":"Password","type":"password","required":true}]}', true, 24, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_mongodb',         'mongodb',          'MongoDB',           'NoSQL document database for modern applications',                   'DATABASE',           'API_KEY', '{"fields":[{"key":"connection_string","label":"Connection String","type":"password","required":true},{"key":"database","label":"Database Name","type":"text","required":true}]}',                                                                               true, 25, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_aws_rds',         'aws_rds',          'AWS RDS',           'Amazon Relational Database Service — managed cloud SQL databases',  'DATABASE',           'API_KEY', '{"fields":[{"key":"region","label":"AWS Region","type":"text","required":true},{"key":"endpoint","label":"RDS Endpoint","type":"text","required":true},{"key":"port","label":"Port","type":"text","required":true},{"key":"database","label":"Database Name","type":"text","required":true},{"key":"username","label":"Username","type":"text","required":true},{"key":"password","label":"Password","type":"password","required":true}]}', true, 26, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cat_mongo_atlas',     'mongo_atlas',      'MongoDB Atlas',     'Fully managed cloud database service for MongoDB',                  'DATABASE',           'API_KEY', '{"fields":[{"key":"connection_string","label":"Atlas Connection String","type":"password","required":true},{"key":"database","label":"Database Name","type":"text","required":true}]}',                                                                         true, 27, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- CUSTOM
('cat_custom_api',      'custom_api',       'Custom API',        'Connect to any REST API with custom authentication and endpoints',  'CUSTOM',             'API_KEY', '{"fields":[{"key":"base_url","label":"Base URL","type":"url","required":true},{"key":"auth_type","label":"Auth Type","type":"text","required":false},{"key":"api_key","label":"API Key / Token","type":"password","required":false},{"key":"custom_headers","label":"Custom Headers (JSON)","type":"text","required":false}]}', true, 28, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ============================================================
-- Seed: catalog_tools
-- ============================================================

-- Shopify tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_shopify_order_lookup',   'order_lookup',   'cat_shopify', 'Order Lookup',   'Look up order details by order ID or customer email', 'READ',   'LOW',  true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_track_shipment', 'track_shipment', 'cat_shopify', 'Track Shipment', 'Track shipment status for an order',                  'READ',   'LOW',  true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_shopify_process_refund', 'process_refund', 'cat_shopify', 'Process Refund', 'Initiate a refund for a Shopify order',               'ACTION', 'HIGH', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_shopify_cancel_order',   'cancel_order',   'cat_shopify', 'Cancel Order',   'Cancel an open Shopify order',                        'DELETE', 'HIGH', true, 4, 'POST', CURRENT_TIMESTAMP);

-- WooCommerce tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_woocommerce_order_lookup',   'order_lookup',   'cat_woocommerce', 'Order Lookup',   'Look up order details in WooCommerce',          'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_product_search', 'product_search', 'cat_woocommerce', 'Product Search', 'Search for products in WooCommerce store',      'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_woocommerce_update_order',   'update_order',   'cat_woocommerce', 'Update Order',   'Update an existing WooCommerce order',          'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- BigCommerce tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_bigcommerce_order_lookup',    'order_lookup',    'cat_bigcommerce', 'Order Lookup',    'Look up order details in BigCommerce',         'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_bigcommerce_customer_search', 'customer_search', 'cat_bigcommerce', 'Customer Search', 'Search for customers in BigCommerce',          'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_bigcommerce_update_product',  'update_product',  'cat_bigcommerce', 'Update Product',  'Update a product listing in BigCommerce',      'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Magento tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_magento_order_lookup',      'order_lookup',      'cat_magento', 'Order Lookup',      'Look up order details in Magento',            'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_magento_customer_search',   'customer_search',   'cat_magento', 'Customer Search',   'Search for customers in Magento',             'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_magento_update_inventory',  'update_inventory',  'cat_magento', 'Update Inventory',  'Update product inventory levels in Magento',  'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Wix tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_wix_order_lookup',   'order_lookup',   'cat_wix', 'Order Lookup',   'Look up order details in Wix store',           'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_wix_site_info',      'site_info',      'cat_wix', 'Site Info',      'Retrieve site and store information from Wix', 'READ',  'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_wix_update_product', 'update_product', 'cat_wix', 'Update Product', 'Update a product in Wix store',                'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Shippo tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_shippo_track_shipment', 'track_shipment', 'cat_shippo', 'Track Shipment', 'Track a shipment by tracking number via Shippo', 'READ',   'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_shippo_create_label',   'create_label',   'cat_shippo', 'Create Label',   'Create a shipping label through Shippo',         'ACTION', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_shippo_get_rates',      'get_rates',      'cat_shippo', 'Get Rates',      'Retrieve shipping rates for a package via Shippo','READ',   'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP);

-- Easyship tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_easyship_track_shipment',  'track_shipment',  'cat_easyship', 'Track Shipment',  'Track a shipment via Easyship',                   'READ',   'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_easyship_create_shipment', 'create_shipment', 'cat_easyship', 'Create Shipment', 'Create a new shipment through Easyship',           'ACTION', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_easyship_get_rates',       'get_rates',       'cat_easyship', 'Get Rates',       'Get shipping rates and options from Easyship',     'READ',   'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP);

-- ShipStation tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_shipstation_track_shipment', 'track_shipment', 'cat_shipstation', 'Track Shipment', 'Track a shipment via ShipStation',              'READ',   'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_shipstation_create_label',   'create_label',   'cat_shipstation', 'Create Label',   'Create a shipping label via ShipStation',        'ACTION', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_shipstation_list_orders',    'list_orders',    'cat_shipstation', 'List Orders',    'List orders in ShipStation',                     'READ',   'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP);

-- AfterShip tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_aftership_track_shipment',   'track_shipment',   'cat_aftership', 'Track Shipment',   'Track a shipment via AfterShip',              'READ',   'LOW', true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_aftership_create_tracking',  'create_tracking',  'cat_aftership', 'Create Tracking',  'Add a new tracking to AfterShip',             'ACTION', 'LOW', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_aftership_list_trackings',   'list_trackings',   'cat_aftership', 'List Trackings',   'List all trackings in AfterShip',             'READ',   'LOW', true, 3, 'GET',  CURRENT_TIMESTAMP);

-- Stripe tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_stripe_payment_lookup', 'payment_lookup', 'cat_stripe', 'Payment Lookup', 'Look up payment details by payment intent or charge ID', 'READ',   'LOW',  true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_stripe_create_refund',  'create_refund',  'cat_stripe', 'Create Refund',  'Create a refund for a Stripe charge or payment',         'ACTION', 'HIGH', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_stripe_list_invoices',  'list_invoices',  'cat_stripe', 'List Invoices',  'List invoices for a customer',                           'READ',   'LOW',  true, 3, 'GET',  CURRENT_TIMESTAMP);

-- PayPal tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_paypal_payment_lookup',    'payment_lookup',    'cat_paypal', 'Payment Lookup',    'Look up a PayPal payment or transaction',      'READ',   'LOW',  true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_paypal_create_refund',     'create_refund',     'cat_paypal', 'Create Refund',     'Create a refund for a PayPal transaction',     'ACTION', 'HIGH', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_paypal_list_transactions', 'list_transactions', 'cat_paypal', 'List Transactions', 'List transactions for a PayPal account',       'READ',   'LOW',  true, 3, 'GET',  CURRENT_TIMESTAMP);

-- Square tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_square_payment_lookup', 'payment_lookup', 'cat_square', 'Payment Lookup', 'Look up a Square payment by ID',                    'READ',   'LOW',  true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_square_create_refund',  'create_refund',  'cat_square', 'Create Refund',  'Create a refund for a Square payment',              'ACTION', 'HIGH', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_square_list_invoices',  'list_invoices',  'cat_square', 'List Invoices',  'List invoices for a Square customer',               'READ',   'LOW',  true, 3, 'GET',  CURRENT_TIMESTAMP);

-- HubSpot tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_hubspot_customer_lookup', 'customer_lookup', 'cat_hubspot', 'Customer Lookup', 'Search for customer contact records in HubSpot',  'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_hubspot_update_contact',  'update_contact',  'cat_hubspot', 'Update Contact',  'Update an existing HubSpot contact record',       'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_hubspot_create_deal',     'create_deal',     'cat_hubspot', 'Create Deal',     'Create a new deal in HubSpot CRM',                'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Salesforce tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_salesforce_contact_search',     'contact_search',     'cat_salesforce', 'Contact Search',     'Search for contacts in Salesforce',                'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_salesforce_create_lead',        'create_lead',        'cat_salesforce', 'Create Lead',        'Create a new lead record in Salesforce',           'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_salesforce_update_opportunity', 'update_opportunity', 'cat_salesforce', 'Update Opportunity', 'Update an existing Salesforce opportunity',        'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Pipedrive tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_pipedrive_deal_lookup',    'deal_lookup',    'cat_pipedrive', 'Deal Lookup',    'Look up a deal in Pipedrive',                     'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_pipedrive_create_deal',    'create_deal',    'cat_pipedrive', 'Create Deal',    'Create a new deal in Pipedrive',                  'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_pipedrive_contact_search', 'contact_search', 'cat_pipedrive', 'Contact Search', 'Search for contacts/persons in Pipedrive',        'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP);

-- Zoho CRM tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_zoho_crm_contact_search', 'contact_search', 'cat_zoho_crm', 'Contact Search', 'Search for contacts in Zoho CRM',                 'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_zoho_crm_create_lead',    'create_lead',    'cat_zoho_crm', 'Create Lead',    'Create a new lead in Zoho CRM',                   'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_zoho_crm_update_deal',    'update_deal',    'cat_zoho_crm', 'Update Deal',    'Update an existing deal in Zoho CRM',             'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Zendesk tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_zendesk_ticket_lookup', 'ticket_lookup', 'cat_zendesk', 'Ticket Lookup', 'Look up a Zendesk support ticket by ID',    'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_zendesk_create_ticket', 'create_ticket', 'cat_zendesk', 'Create Ticket', 'Create a new Zendesk support ticket',       'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_zendesk_update_ticket', 'update_ticket', 'cat_zendesk', 'Update Ticket', 'Update an existing Zendesk support ticket', 'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Intercom tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_intercom_user_lookup',  'user_lookup',  'cat_intercom', 'User Lookup',  'Look up a user or lead in Intercom',             'READ',   'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_intercom_send_message', 'send_message', 'cat_intercom', 'Send Message', 'Send an outbound message to a user via Intercom', 'ACTION', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_intercom_create_note',  'create_note',  'cat_intercom', 'Create Note',  'Add a note to a conversation in Intercom',        'WRITE',  'LOW',    true, 3, 'POST', CURRENT_TIMESTAMP);

-- Monday.com tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_monday_list_boards',  'list_boards',  'cat_monday', 'List Boards',  'List all boards in Monday.com workspace',          'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_monday_create_item',  'create_item',  'cat_monday', 'Create Item',  'Create a new item on a Monday.com board',          'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_monday_update_item',  'update_item',  'cat_monday', 'Update Item',  'Update an existing item on a Monday.com board',    'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Google Calendar tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_google_calendar_list_events',        'list_events',        'cat_google_calendar', 'List Events',        'List upcoming events from Google Calendar',        'READ',  'LOW',    true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_google_calendar_create_event',       'create_event',       'cat_google_calendar', 'Create Event',       'Create a new event in Google Calendar',            'WRITE', 'MEDIUM', true, 2, 'POST', CURRENT_TIMESTAMP),
('tool_google_calendar_check_availability', 'check_availability', 'cat_google_calendar', 'Check Availability', 'Check calendar availability for a given time slot', 'READ',  'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP);

-- Calendly tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_calendly_list_events',      'list_events',      'cat_calendly', 'List Events',      'List scheduled events in Calendly',               'READ',   'LOW',  true, 1, 'GET',  CURRENT_TIMESTAMP),
('tool_calendly_get_event_details','get_event_details','cat_calendly', 'Get Event Details','Retrieve details of a specific Calendly event',   'READ',   'LOW',  true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_calendly_cancel_event',     'cancel_event',     'cat_calendly', 'Cancel Event',     'Cancel a scheduled Calendly event',               'ACTION', 'HIGH', true, 3, 'POST', CURRENT_TIMESTAMP);

-- Slack tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_slack_send_notification', 'send_notification', 'cat_slack', 'Send Notification', 'Send a message or notification to a Slack channel', 'ACTION', 'LOW', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_slack_list_channels',     'list_channels',     'cat_slack', 'List Channels',     'List available Slack channels',                     'READ',   'LOW', true, 2, 'GET',  CURRENT_TIMESTAMP);

-- Google Analytics tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_ga_get_report',   'get_report',   'cat_google_analytics', 'Get Report',   'Fetch a standard analytics report',       'READ', 'LOW', true, 1, 'GET', CURRENT_TIMESTAMP),
('tool_ga_get_realtime', 'get_realtime', 'cat_google_analytics', 'Get Realtime', 'Fetch realtime active users and metrics', 'READ', 'LOW', true, 2, 'GET', CURRENT_TIMESTAMP);

-- PostgreSQL tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_pg_query',          'run_query',      'cat_postgresql', 'Run Query',      'Execute a read-only SQL query and return results',      'READ',   'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_pg_list_tables',    'list_tables',    'cat_postgresql', 'List Tables',    'List all tables and views in the database',             'READ',   'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_pg_describe_table', 'describe_table', 'cat_postgresql', 'Describe Table', 'Show column names, types, and constraints for a table', 'READ',   'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_pg_insert_row',     'insert_row',     'cat_postgresql', 'Insert Row',     'Insert a new row into a specified table',               'WRITE',  'HIGH',   true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_pg_update_rows',    'update_rows',    'cat_postgresql', 'Update Rows',    'Update rows matching a condition in a table',            'WRITE',  'HIGH',   true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_pg_delete_rows',    'delete_rows',    'cat_postgresql', 'Delete Rows',    'Delete rows matching a condition from a table',          'DELETE', 'HIGH',   true, 6, 'POST', CURRENT_TIMESTAMP);

-- MongoDB tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_mongo_find',              'find_documents',   'cat_mongodb', 'Find Documents',   'Query documents in a collection with filters and projections', 'READ',   'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_list_collections',  'list_collections', 'cat_mongodb', 'List Collections', 'List all collections in the database',                         'READ',   'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_mongo_aggregate',         'aggregate',        'cat_mongodb', 'Aggregate',        'Run an aggregation pipeline on a collection',                  'READ',   'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_insert_document',   'insert_document',  'cat_mongodb', 'Insert Document',  'Insert a new document into a collection',                      'WRITE',  'HIGH',   true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_update_documents',  'update_documents', 'cat_mongodb', 'Update Documents', 'Update documents matching a filter in a collection',            'WRITE',  'HIGH',   true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_mongo_delete_documents',  'delete_documents', 'cat_mongodb', 'Delete Documents', 'Delete documents matching a filter from a collection',          'DELETE', 'HIGH',   true, 6, 'POST', CURRENT_TIMESTAMP);

-- AWS RDS tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_rds_query',          'run_query',      'cat_aws_rds', 'Run Query',      'Execute a read-only SQL query against the RDS instance',  'READ',   'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_rds_list_tables',    'list_tables',    'cat_aws_rds', 'List Tables',    'List all tables and views in the RDS database',            'READ',   'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_rds_describe_table', 'describe_table', 'cat_aws_rds', 'Describe Table', 'Show column names, types, and constraints for a table',    'READ',   'LOW',    true, 3, 'GET',  CURRENT_TIMESTAMP),
('tool_rds_insert_row',     'insert_row',     'cat_aws_rds', 'Insert Row',     'Insert a new row into a specified table',                  'WRITE',  'HIGH',   true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_rds_update_rows',    'update_rows',    'cat_aws_rds', 'Update Rows',    'Update rows matching a condition in a table',               'WRITE',  'HIGH',   true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_rds_delete_rows',    'delete_rows',    'cat_aws_rds', 'Delete Rows',    'Delete rows matching a condition from a table',             'DELETE', 'HIGH',   true, 6, 'POST', CURRENT_TIMESTAMP);

-- MongoDB Atlas tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_atlas_find',              'find_documents',   'cat_mongo_atlas', 'Find Documents',   'Query documents in an Atlas collection with filters',       'READ',   'MEDIUM', true, 1, 'POST', CURRENT_TIMESTAMP),
('tool_atlas_list_collections',  'list_collections', 'cat_mongo_atlas', 'List Collections', 'List all collections in the Atlas database',                'READ',   'LOW',    true, 2, 'GET',  CURRENT_TIMESTAMP),
('tool_atlas_aggregate',         'aggregate',        'cat_mongo_atlas', 'Aggregate',        'Run an aggregation pipeline on an Atlas collection',        'READ',   'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
('tool_atlas_insert_document',   'insert_document',  'cat_mongo_atlas', 'Insert Document',  'Insert a new document into an Atlas collection',            'WRITE',  'HIGH',   true, 4, 'POST', CURRENT_TIMESTAMP),
('tool_atlas_update_documents',  'update_documents', 'cat_mongo_atlas', 'Update Documents', 'Update documents matching a filter in an Atlas collection', 'WRITE',  'HIGH',   true, 5, 'POST', CURRENT_TIMESTAMP),
('tool_atlas_delete_documents',  'delete_documents', 'cat_mongo_atlas', 'Delete Documents', 'Delete documents matching a filter from an Atlas collection','DELETE', 'HIGH',   true, 6, 'POST', CURRENT_TIMESTAMP);

-- Custom API tools
INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_api_get',    'http_get',    'cat_custom_api', 'GET Request',    'Send a GET request to a custom API endpoint',                  'READ',   'MEDIUM', true, 1, 'GET',    CURRENT_TIMESTAMP),
('tool_api_post',   'http_post',   'cat_custom_api', 'POST Request',   'Send a POST request with a JSON body to a custom API endpoint','WRITE',  'HIGH',   true, 2, 'POST',   CURRENT_TIMESTAMP),
('tool_api_put',    'http_put',    'cat_custom_api', 'PUT Request',    'Send a PUT request with a JSON body to update a resource',     'WRITE',  'HIGH',   true, 3, 'PUT',    CURRENT_TIMESTAMP),
('tool_api_patch',  'http_patch',  'cat_custom_api', 'PATCH Request',  'Send a PATCH request with partial updates to a resource',      'WRITE',  'MEDIUM', true, 4, 'PATCH',  CURRENT_TIMESTAMP),
('tool_api_delete', 'http_delete', 'cat_custom_api', 'DELETE Request', 'Send a DELETE request to remove a resource',                   'DELETE', 'HIGH',   true, 5, 'DELETE', CURRENT_TIMESTAMP);
