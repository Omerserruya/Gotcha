-- Zoho describe_fields catalog tool
--
-- Powers the audience builder's CRM provenance banner and filter-field
-- picker. crm.ts:getCrmSchema() looks for a tenant tool with slug
-- "describe_fields" tied to the connected CRM and dispatches it.
-- Without this row, Zoho-connected tenants would see "0 CRM fields
-- available" even though the integration is fully connected.
--
-- Endpoint: GET /crm/v7/settings/fields?module=Leads (or Contacts/...)
-- The HTTP executor passes our input as query params, so {module:"Leads"}
-- lands as ?module=Leads on the upstream call.

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "created_at")
VALUES
  ('tool_zoho_crm_describe_fields', 'describe_fields', 'cat_zoho_crm',
   'Describe Fields',
   'Return the field schema (name/label/type/picklist values) for a Zoho module - Leads, Contacts, Accounts, or Deals.',
   'READ', 'LOW', true, 99, 'GET', '/crm/v7/settings/fields',
   '{
     "type": "object",
     "description": "Describe fields on a Zoho module.",
     "required": ["module"],
     "properties": {
       "module": {
         "type": "string",
         "enum": ["Leads", "Contacts", "Accounts", "Deals"],
         "description": "Zoho module name (Title-Case)."
       }
     }
   }'::jsonb,
   CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
