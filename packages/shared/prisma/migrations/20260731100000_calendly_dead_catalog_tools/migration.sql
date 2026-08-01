-- Calendly: finish what 20260720090000_calendar_catalog_honesty started.
--
-- That migration unpublished calendly, on the grounds that it "has no
-- registered ProviderAdapter at all ... exposes no tools". Both still true:
-- calendly.adapter.ts implements CalendarAdapter (the schedule_meeting /
-- availability path), never calls registerAdapter(), and is not imported by
-- connectors/index.ts. It left calendly's three catalog_tools rows in place,
-- though, while dropping google_calendar's phantom rows for the same reason.
--
-- Those three rows advertise capabilities that cannot execute:
--   list_events, get_event_details, cancel_event
-- Each has a NULL endpoint and no adapter tool definition to match, so any
-- surface that reads the catalog sees three tools where the runtime has zero.
--
-- Left as-is they are not inert. `catalog_tools` is what the tool gate and the
-- Integrations & Tools workspace count, so a future `is_published = true`
-- (or any screen that ignores is_published, which is exactly the bug this
-- change fixes) would offer an AI employee three tools that fail on call.
--
-- The OAuth plumbing, the tenant_integrations rows and the CalendarAdapter are
-- untouched. Booking through Calendly still works the way it does today, via
-- schedule_meeting. These rows come back with the ProviderAdapter that can
-- honour them.

DELETE FROM "tenant_tools"
WHERE "catalog_tool_id" IN (
  SELECT t."id" FROM "catalog_tools" t
  JOIN "integration_catalog" c ON c."id" = t."integration_id"
  WHERE c."slug" = 'calendly'
);

DELETE FROM "catalog_tools"
WHERE "integration_id" IN (
  SELECT "id" FROM "integration_catalog" WHERE "slug" = 'calendly'
);
