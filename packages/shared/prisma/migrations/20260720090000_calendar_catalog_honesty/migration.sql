-- Calendar integrations: make the catalog tell the truth.
--
-- The catalog advertised capabilities that do not exist, in two ways:
--
--  * google_calendar published THREE tools (list_events, create_event,
--    check_availability) but its ProviderAdapter implements only
--    `list_events` - `execute()` throws "unsupported google_calendar tool"
--    for the other two. Because the tool gate surfaces whatever the catalog
--    lists, an AI employee could pick `google_calendar.create_event` and hit a
--    hard failure mid-conversation. By design those capabilities are reached
--    through other paths (booking via the validated `schedule_meeting` flow,
--    availability via the built-in `check_availability` resolver), so the
--    catalog rows are simply wrong and are removed here.
--
--  * calendly has no registered ProviderAdapter at all (never passed to
--    registerAdapter, not imported by connectors/index.ts), exposes no tools,
--    and its booking path needs an `eventTypeUri` that nothing in the OAuth
--    callback or any settings screen ever populates. The OAuth plumbing works,
--    but a tenant who "connects" it gains no capability. Rather than present a
--    fake connection workflow it is unpublished until the adapter and an
--    event-type picker exist. Existing tenant_integrations rows are left
--    untouched (no data loss; it returns the moment is_published flips back).

-- 1. Drop the phantom Google Calendar tools + any tenant activations of them.
DELETE FROM "tenant_tools"
WHERE "catalog_tool_id" IN (
  SELECT "id" FROM "catalog_tools"
  WHERE "integration_id" = 'cat_google_calendar' AND "slug" IN ('create_event', 'check_availability')
);
DELETE FROM "catalog_tools"
WHERE "integration_id" = 'cat_google_calendar' AND "slug" IN ('create_event', 'check_availability');

-- 2. Google Calendar: record the scopes the OAuth init actually requests.
UPDATE "integration_catalog"
SET "auth_schema" = '{"fields":[],"oauth":true,"scopes":["https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/userinfo.email"]}'::jsonb
WHERE "slug" = 'google_calendar';

-- 3. Calendly: stop advertising an integration that cannot do anything yet.
UPDATE "integration_catalog"
SET "is_published" = false,
    "description" = 'Calendly scheduling. Temporarily unavailable: the GOTCHA connector is incomplete (no tool surface and no event-type selection), so it cannot yet be used by an AI employee.'
WHERE "slug" = 'calendly';
