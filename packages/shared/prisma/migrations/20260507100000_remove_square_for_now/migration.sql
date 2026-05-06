-- Remove Square from the marketplace catalog.
--
-- Square is temporarily disabled — the OAuth flow needs a registered
-- Square application + production/sandbox toggle that we haven't fully
-- wired yet. The adapter file
-- (services/ai/src/services/connectors/square.adapter.ts) and this
-- migration's parallel content stay in git history for easy revert.
--
-- ON DELETE CASCADE handles catalog_tools + tenant_integrations cleanup.

DELETE FROM "integration_catalog" WHERE "slug" = 'square';
