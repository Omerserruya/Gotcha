-- Airtable: promote to an OAuth2 connector that can act as a CRM source of
-- truth. Auth flips from PAT to OAuth2 (PKCE handled in connectors-admin.ts).
-- can_act_as_crm = true so it surfaces in the CRM-locked Integrations explorer
-- and as an onboarding core-system option. The base/table/column mapping is
-- captured post-OAuth and stored on tenant_integrations.config (fieldMap,
-- notesField, idempotencyField, baseId, tableId).

UPDATE "integration_catalog"
SET "auth_type" = 'OAUTH2',
    "can_act_as_crm" = true,
    "description" = 'Use an Airtable base as your customer source of truth — map your contacts table''s columns and the AI reads/writes there.',
    "config_schema" = '{"fields":[{"key":"baseId","label":"Base","type":"select","helpText":"Pick the Airtable base."},{"key":"tableId","label":"Table","type":"select","helpText":"Pick the contacts table."},{"key":"fieldMap","label":"Column mapping","type":"object","helpText":"Map email / phone / name / stage to your columns."},{"key":"notesField","label":"Notes column","type":"text","helpText":"Long-text column the AI appends notes to."},{"key":"idempotencyField","label":"Idempotency column","type":"text","required":false}]}',
    "is_published" = true
WHERE "slug" = 'airtable';
