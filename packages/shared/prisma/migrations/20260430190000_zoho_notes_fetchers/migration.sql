-- Two read-only Zoho catalog tools used by the bot's CRM prefetch
-- (services/ai/src/services/crm-prefetch.service.ts) to pull recent
-- timeline notes for the customer's existing lead/contact at the start
-- of every autonomous turn. The notes are injected into the system
-- prompt as part of the `## Existing CRM Records` block so the bot
-- has prior interaction context without having to call the tool.
--
-- Both are READ tools with hitl_policy=never (no approval friction).
-- Endpoints use Zoho v7's per-record Notes sub-resource.

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description", "when_to_use",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "hitl_policy", "allowed_modes", "created_at")
VALUES
  ('tool_zoho_crm_get_lead_notes', 'get_lead_notes', 'cat_zoho_crm',
   'Get Lead Notes',
   'Fetch the timeline notes for a Zoho lead by record id.',
   'Use to recall what was said or done with this lead in past interactions before drafting a reply. Pre-fetched automatically at the start of every conversation turn - you usually do not need to call this directly.',
   'READ', 'LOW', true, 16, 'GET', '/crm/v7/Leads/:id/Notes',
   '{
     "type": "object",
     "description": "Get notes attached to a Zoho lead.",
     "required": ["id"],
     "properties": {
       "id": { "type": "string", "description": "Zoho lead record id (path param)" }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_get_contact_notes', 'get_contact_notes', 'cat_zoho_crm',
   'Get Contact Notes',
   'Fetch the timeline notes for a Zoho contact by record id.',
   'Use to recall conversation history attached to a known contact. Pre-fetched automatically at the start of every conversation turn.',
   'READ', 'LOW', true, 25, 'GET', '/crm/v7/Contacts/:id/Notes',
   '{
     "type": "object",
     "description": "Get notes attached to a Zoho contact.",
     "required": ["id"],
     "properties": {
       "id": { "type": "string", "description": "Zoho contact record id (path param)" }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
