-- Wire up Zoho CRM catalog tools with real API endpoints + input schemas.
--
-- Seeded by 20260312150000_marketplace_architecture with slug/category/method
-- only - endpoint and inputSchema were left NULL / empty, so tool-execution
-- refuses to dispatch them ("no endpoint configured"). This migration fills
-- those in against Zoho CRM API v7.
--
-- Endpoints are RELATIVE (start with "/") - tool-execution.service.ts will
-- prepend TenantIntegration.config.baseUrl (the region-specific api_domain
-- Zoho returns at token exchange time, e.g. https://www.zohoapis.com or
-- https://www.zohoapis.eu). This lets the same catalog row work for every
-- Zoho datacenter.
--
-- The `description` on inputSchema documents the Zoho body shape for the
-- planner (which sees inputSchema in the tool surface). Zoho expects
-- {"data":[{...}]} wrappers on writes.

-- contact_search - GET /crm/v7/Contacts/search
-- Zoho accepts `email`, `phone`, or `word` query params.
UPDATE "catalog_tools"
SET
  "endpoint"     = '/crm/v7/Contacts/search',
  "method"       = 'GET',
  "input_schema" = '{
    "type": "object",
    "description": "Search Zoho CRM contacts by email, phone, or free-text word. Pass exactly one of the three.",
    "properties": {
      "email": { "type": "string", "description": "Contact email to match" },
      "phone": { "type": "string", "description": "Contact phone to match" },
      "word":  { "type": "string", "description": "Free-text search word" }
    }
  }'::jsonb
WHERE "id" = 'tool_zoho_crm_contact_search';

-- create_lead - POST /crm/v7/Leads
-- Zoho requires Last_Name. Body shape: { data: [{ Last_Name, ... }] }.
UPDATE "catalog_tools"
SET
  "endpoint"     = '/crm/v7/Leads',
  "method"       = 'POST',
  "input_schema" = '{
    "type": "object",
    "description": "Create a lead in Zoho CRM. Wrap the record in {\"data\":[{...}]}. Last_Name is required by Zoho.",
    "required": ["data"],
    "properties": {
      "data": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["Last_Name"],
          "properties": {
            "Last_Name":   { "type": "string" },
            "First_Name":  { "type": "string" },
            "Email":       { "type": "string" },
            "Phone":       { "type": "string" },
            "Company":     { "type": "string" },
            "Lead_Source": { "type": "string" },
            "Description": { "type": "string" }
          }
        }
      }
    }
  }'::jsonb
WHERE "id" = 'tool_zoho_crm_create_lead';

-- update_deal - PUT /crm/v7/Deals/:id
-- `id` becomes the Zoho deal record id via the :param URL-substitution path.
UPDATE "catalog_tools"
SET
  "endpoint"     = '/crm/v7/Deals/:id',
  "method"       = 'PUT',
  "input_schema" = '{
    "type": "object",
    "description": "Update a Zoho CRM deal by record id. `id` is used in the URL; other fields belong inside {\"data\":[{...}]}.",
    "required": ["id", "data"],
    "properties": {
      "id":   { "type": "string", "description": "Zoho deal record id (path param)" },
      "data": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "Deal_Name":    { "type": "string" },
            "Stage":        { "type": "string" },
            "Amount":       { "type": "number" },
            "Closing_Date": { "type": "string", "format": "date" },
            "Probability":  { "type": "number" },
            "Description":  { "type": "string" }
          }
        }
      }
    }
  }'::jsonb
WHERE "id" = 'tool_zoho_crm_update_deal';
