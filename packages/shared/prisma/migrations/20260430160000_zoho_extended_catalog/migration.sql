-- Extended Zoho CRM catalog tools.
--
-- Adds the lead/contact/deal/task lifecycle tools the autonomous agent
-- needs to "check before create / update / tag / convert" without
-- escaping back to the human. Also fills `when_to_use` for the existing
-- three Zoho tools so the LLM has clear gating signals.
--
-- Endpoints are RELATIVE; tool-execution.service.ts prepends the
-- TenantIntegration.config.baseUrl returned by Zoho at token exchange
-- (https://www.zohoapis.com / .eu / .in / etc.). Path params use `:id`
-- — same pattern the existing `update_deal` row already uses.
--
-- HITL policy defaults:
--   - READS                              → "never"  (lookups don't need approval)
--   - low-risk WRITES (notes, tags,
--     field updates)                     → "never"  (let the bot operate
--                                                   autonomously per the user's
--                                                   "manage like a professional"
--                                                   directive)
--   - lifecycle changes (convert_lead)   → "always" (irreversible-ish; require
--                                                   human approval)
--
-- Operators can tighten any of these per-tenant via TenantTool.configOverrides
-- or per-agent via AgentToolPermission.requireApproval. See the F4 design.
--
-- Idempotent: uses ON CONFLICT DO NOTHING for INSERTs so re-running this
-- migration in environments that already have the rows is safe.

-- ─── Backfill `when_to_use` on the existing 3 Zoho tools ──────────────────
UPDATE "catalog_tools" SET "when_to_use" =
  'Search Zoho CRM contacts by email, phone, or free-text. Call this BEFORE create_lead/create_contact to avoid duplicates. Pass exactly one of email/phone/word.'
WHERE "id" = 'tool_zoho_crm_contact_search';

UPDATE "catalog_tools" SET "when_to_use" =
  'Create a new Zoho lead. Call ONLY after: (1) you confirmed no existing lead/contact via lead_search/contact_search, (2) you have at least Last_Name AND (Email OR Phone), (3) the customer has shown qualifying intent. Do not call after a single greeting.'
WHERE "id" = 'tool_zoho_crm_create_lead';

UPDATE "catalog_tools" SET "when_to_use" =
  'Update a Zoho deal by id. Call when the customer or context provides new information about an existing deal (stage change, amount adjustment, closing date, notes).'
WHERE "id" = 'tool_zoho_crm_update_deal';


-- ─── Leads — search / get / update / note / tag / convert ────────────────

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description", "when_to_use",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "hitl_policy", "allowed_modes", "created_at")
VALUES
  ('tool_zoho_crm_lead_search', 'lead_search', 'cat_zoho_crm',
   'Lead Search',
   'Search Zoho CRM leads by email, phone, or free-text.',
   'Call BEFORE create_lead to check whether a lead for this customer already exists. Pass exactly one of email/phone/word. If a match is returned, prefer update_lead over create_lead.',
   'READ', 'LOW', true, 10, 'GET', '/crm/v7/Leads/search',
   '{
     "type": "object",
     "description": "Search Zoho leads. Pass exactly one of email/phone/word.",
     "properties": {
       "email": { "type": "string", "description": "Lead email to match" },
       "phone": { "type": "string", "description": "Lead phone to match (E.164 preferred)" },
       "word":  { "type": "string", "description": "Free-text search term" }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_get_lead', 'get_lead', 'cat_zoho_crm',
   'Get Lead',
   'Fetch the full record of a Zoho lead by id.',
   'Use after lead_search returned an id and you need the full record to decide on next action (update fields, convert, add a note).',
   'READ', 'LOW', true, 11, 'GET', '/crm/v7/Leads/:id',
   '{
     "type": "object",
     "description": "Get a single Zoho lead by record id.",
     "required": ["id"],
     "properties": {
       "id": { "type": "string", "description": "Zoho lead record id (path param)" }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_update_lead', 'update_lead', 'cat_zoho_crm',
   'Update Lead',
   'Update fields on an existing Zoho lead.',
   'Use INSTEAD of create_lead when lead_search returned a match — to enrich the existing record (add Phone, Email, Company, Lead_Source, Description, etc.). `id` goes in the URL; field updates go inside data[].',
   'WRITE', 'LOW', true, 12, 'PUT', '/crm/v7/Leads/:id',
   '{
     "type": "object",
     "description": "Update a Zoho lead by id. id → URL; fields → {data:[{...}]}.",
     "required": ["id", "data"],
     "properties": {
       "id": { "type": "string", "description": "Zoho lead record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "First_Name":  { "type": "string" },
             "Last_Name":   { "type": "string" },
             "Email":       { "type": "string" },
             "Phone":       { "type": "string" },
             "Company":     { "type": "string" },
             "Lead_Source": { "type": "string" },
             "Lead_Status": { "type": "string" },
             "Description": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_add_lead_note', 'add_lead_note', 'cat_zoho_crm',
   'Add Lead Note',
   'Add a timeline note to a Zoho lead.',
   'Use to record what happened in the conversation onto the lead record (e.g. customer asked about pricing, requested a demo, expressed objection). Notes are append-only and low-risk.',
   'WRITE', 'LOW', true, 13, 'POST', '/crm/v7/Leads/:id/Notes',
   '{
     "type": "object",
     "description": "Append a note to a Zoho lead. id → URL; data[] holds {Note_Title, Note_Content}.",
     "required": ["id", "data"],
     "properties": {
       "id": { "type": "string", "description": "Zoho lead record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["Note_Content"],
           "properties": {
             "Note_Title":   { "type": "string" },
             "Note_Content": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_add_lead_tag', 'add_lead_tag', 'cat_zoho_crm',
   'Add Lead Tag',
   'Tag a Zoho lead for segmentation, scoring, or routing.',
   'Use to mark the lead with one or more tags (e.g. ''hot'', ''demo-requested'', ''hebrew-speaker''). Tagging is idempotent and low-risk; safe for autonomous use.',
   'WRITE', 'LOW', true, 14, 'POST', '/crm/v7/Leads/:id/actions/add_tags',
   '{
     "type": "object",
     "description": "Add tag(s) to a lead. id → URL; tags → array of {name}.",
     "required": ["id", "tags"],
     "properties": {
       "id":   { "type": "string", "description": "Zoho lead record id (path param)" },
       "tags": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["name"],
           "properties": { "name": { "type": "string" } }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_convert_lead', 'convert_lead', 'cat_zoho_crm',
   'Convert Lead',
   'Convert a Zoho lead to a contact, account, and (optionally) deal.',
   'Use only when the customer has clearly committed (purchase decision, signed quote, scheduled onboarding). This is a one-way lifecycle change — gated by human approval by default.',
   'WRITE', 'HIGH', true, 15, 'POST', '/crm/v7/Leads/:id/actions/convert',
   '{
     "type": "object",
     "description": "Convert a lead. id → URL; data[] contains conversion options.",
     "required": ["id", "data"],
     "properties": {
       "id":   { "type": "string", "description": "Zoho lead record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "overwrite":             { "type": "boolean" },
             "notify_lead_owner":     { "type": "boolean" },
             "notify_new_entity_owner": { "type": "boolean" },
             "Accounts":              { "type": "string", "description": "Account name to attach" },
             "Deals":                 { "type": "object", "description": "Optional deal payload {Deal_Name, Stage, Amount, Closing_Date}" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"always"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;


-- ─── Contacts — get / create / update / note / tag ───────────────────────

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description", "when_to_use",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "hitl_policy", "allowed_modes", "created_at")
VALUES
  ('tool_zoho_crm_get_contact', 'get_contact', 'cat_zoho_crm',
   'Get Contact',
   'Fetch the full record of a Zoho contact by id.',
   'Use after contact_search returned an id and you need the full record (associated account, deals, notes).',
   'READ', 'LOW', true, 20, 'GET', '/crm/v7/Contacts/:id',
   '{
     "type": "object",
     "description": "Get a Zoho contact by record id.",
     "required": ["id"],
     "properties": { "id": { "type": "string", "description": "Zoho contact record id (path param)" } }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_create_contact', 'create_contact', 'cat_zoho_crm',
   'Create Contact',
   'Create a Zoho contact (an existing person you''re tracking, distinct from a fresh inbound lead).',
   'Use INSTEAD of create_lead when the customer is already known to the business (existing client, partner, internal stakeholder). Otherwise prefer create_lead. Last_Name is required by Zoho.',
   'WRITE', 'MEDIUM', true, 21, 'POST', '/crm/v7/Contacts',
   '{
     "type": "object",
     "description": "Create a Zoho contact. Wrap in {data:[{...}]}. Last_Name required.",
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
             "Account_Name": { "type": "string" },
             "Title":       { "type": "string" },
             "Description": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_update_contact', 'update_contact', 'cat_zoho_crm',
   'Update Contact',
   'Update fields on an existing Zoho contact.',
   'Use to enrich an existing contact when contact_search returned a match (add phone, email, title, or update an out-of-date field).',
   'WRITE', 'LOW', true, 22, 'PUT', '/crm/v7/Contacts/:id',
   '{
     "type": "object",
     "description": "Update a Zoho contact by id.",
     "required": ["id", "data"],
     "properties": {
       "id": { "type": "string", "description": "Zoho contact record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "First_Name":  { "type": "string" },
             "Last_Name":   { "type": "string" },
             "Email":       { "type": "string" },
             "Phone":       { "type": "string" },
             "Title":       { "type": "string" },
             "Description": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_add_contact_note', 'add_contact_note', 'cat_zoho_crm',
   'Add Contact Note',
   'Add a timeline note to a Zoho contact.',
   'Use to record conversation outcomes onto an existing contact (questions asked, requests, follow-up commitments).',
   'WRITE', 'LOW', true, 23, 'POST', '/crm/v7/Contacts/:id/Notes',
   '{
     "type": "object",
     "description": "Append a note to a Zoho contact.",
     "required": ["id", "data"],
     "properties": {
       "id":   { "type": "string", "description": "Zoho contact record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["Note_Content"],
           "properties": {
             "Note_Title":   { "type": "string" },
             "Note_Content": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_add_contact_tag', 'add_contact_tag', 'cat_zoho_crm',
   'Add Contact Tag',
   'Tag a Zoho contact for segmentation/routing.',
   'Use to mark a contact with descriptive tags (e.g. ''vip'', ''renewal-due'', ''english-speaker'').',
   'WRITE', 'LOW', true, 24, 'POST', '/crm/v7/Contacts/:id/actions/add_tags',
   '{
     "type": "object",
     "required": ["id", "tags"],
     "properties": {
       "id":   { "type": "string", "description": "Zoho contact record id (path param)" },
       "tags": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["name"],
           "properties": { "name": { "type": "string" } }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;


-- ─── Deals — search / get / create / note ────────────────────────────────

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description", "when_to_use",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "hitl_policy", "allowed_modes", "created_at")
VALUES
  ('tool_zoho_crm_deal_search', 'deal_search', 'cat_zoho_crm',
   'Deal Search',
   'Search Zoho deals by free-text or filter.',
   'Use to find an existing deal before creating a new one, or to recall a deal''s stage/amount during a conversation.',
   'READ', 'LOW', true, 30, 'GET', '/crm/v7/Deals/search',
   '{
     "type": "object",
     "description": "Search Zoho deals.",
     "properties": {
       "word":     { "type": "string", "description": "Free-text search term" },
       "criteria": { "type": "string", "description": "Optional Zoho criteria expression" }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_get_deal', 'get_deal', 'cat_zoho_crm',
   'Get Deal',
   'Fetch the full record of a Zoho deal by id.',
   'Use after deal_search to retrieve full deal context (associated contact, stage history, amount).',
   'READ', 'LOW', true, 31, 'GET', '/crm/v7/Deals/:id',
   '{
     "type": "object",
     "required": ["id"],
     "properties": { "id": { "type": "string", "description": "Zoho deal record id (path param)" } }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_create_deal', 'create_deal', 'cat_zoho_crm',
   'Create Deal',
   'Create a new Zoho deal.',
   'Use when the customer commits to a quoted/negotiated opportunity and you have at minimum Deal_Name + Stage + (Amount OR Closing_Date). Prefer convert_lead if you''re promoting an existing lead.',
   'WRITE', 'MEDIUM', true, 32, 'POST', '/crm/v7/Deals',
   '{
     "type": "object",
     "description": "Create a Zoho deal. Wrap in {data:[{...}]}.",
     "required": ["data"],
     "properties": {
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["Deal_Name", "Stage"],
           "properties": {
             "Deal_Name":     { "type": "string" },
             "Stage":         { "type": "string" },
             "Amount":        { "type": "number" },
             "Closing_Date":  { "type": "string", "format": "date" },
             "Account_Name":  { "type": "string" },
             "Contact_Name":  { "type": "string" },
             "Description":   { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"always"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP),

  ('tool_zoho_crm_add_deal_note', 'add_deal_note', 'cat_zoho_crm',
   'Add Deal Note',
   'Add a timeline note to a Zoho deal.',
   'Use to record conversation outcomes onto a deal (objection raised, discount requested, demo completed, next step agreed).',
   'WRITE', 'LOW', true, 33, 'POST', '/crm/v7/Deals/:id/Notes',
   '{
     "type": "object",
     "required": ["id", "data"],
     "properties": {
       "id":   { "type": "string", "description": "Zoho deal record id (path param)" },
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["Note_Content"],
           "properties": {
             "Note_Title":   { "type": "string" },
             "Note_Content": { "type": "string" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;


-- ─── Tasks — create ──────────────────────────────────────────────────────

INSERT INTO "catalog_tools"
  ("id", "slug", "integration_id", "name", "description", "when_to_use",
   "category", "risk_level", "is_default", "sort_order", "method", "endpoint",
   "input_schema", "hitl_policy", "allowed_modes", "created_at")
VALUES
  ('tool_zoho_crm_create_task', 'create_task', 'cat_zoho_crm',
   'Create Task',
   'Create a follow-up task in Zoho CRM linked to a lead, contact, or deal.',
   'Use to schedule a follow-up the human team should take (call back, send proposal, check in next week). Prefer this over making promises in chat about future actions.',
   'WRITE', 'LOW', true, 40, 'POST', '/crm/v7/Tasks',
   '{
     "type": "object",
     "description": "Create a Zoho task. Wrap in {data:[{...}]}.",
     "required": ["data"],
     "properties": {
       "data": {
         "type": "array",
         "items": {
           "type": "object",
           "required": ["Subject"],
           "properties": {
             "Subject":     { "type": "string" },
             "Status":      { "type": "string", "description": "Default: Not Started" },
             "Priority":    { "type": "string", "description": "Low | Normal | High" },
             "Due_Date":    { "type": "string", "format": "date" },
             "Description": { "type": "string" },
             "Se_Module":   { "type": "string", "description": "Module of related record (Leads/Contacts/Deals)" },
             "What_Id":     { "type": "string", "description": "Related record id" }
           }
         }
       }
     }
   }'::jsonb,
   '{"mode":"never"}'::jsonb, '["AUTO","ASSIST"]'::jsonb, CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
