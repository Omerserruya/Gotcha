-- HubSpot Leads tools (Sales Hub Enterprise dedicated /crm/v3/objects/leads).
-- Adapter: services/ai/src/services/connectors/hubspot.adapter.ts
-- Tenants on Pro/Starter will see these in the marketplace too - calls 403
-- gracefully (the LLM gets ok:false and pivots to create_contact).

INSERT INTO "catalog_tools" ("id", "slug", "integration_id", "name", "description", "category", "risk_level", "is_default", "sort_order", "method", "created_at") VALUES
('tool_hubspot_create_lead',  'create_lead',  'cat_hubspot', 'Create Lead',   'Create a HubSpot Lead (Sales Hub Enterprise pre-Contact object).', 'WRITE', 'LOW',    true,  7, 'POST',  CURRENT_TIMESTAMP),
('tool_hubspot_update_lead',  'update_lead',  'cat_hubspot', 'Update Lead',   'Patch properties on an existing HubSpot Lead.',                    'WRITE', 'LOW',    true,  8, 'PATCH', CURRENT_TIMESTAMP),
('tool_hubspot_get_lead',     'get_lead',     'cat_hubspot', 'Get Lead',      'Read a HubSpot Lead by id.',                                       'READ',  'LOW',    true,  9, 'GET',   CURRENT_TIMESTAMP),
('tool_hubspot_search_leads', 'search_leads', 'cat_hubspot', 'Search Leads',  'Search HubSpot Leads by query (name/owner/label).',                'READ',  'LOW',    true, 10, 'POST',  CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
