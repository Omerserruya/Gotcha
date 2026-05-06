-- Remove Wix from the marketplace catalog.
--
-- Wix is temporarily disabled — the Wix App OAuth install flow needs a
-- registered Wix App in dev.wix.com which we haven't shipped yet. The
-- adapter file (services/ai/src/services/connectors/wix.adapter.ts) and
-- this migration's INSERTs are kept in git history for easy revert.
--
-- ON DELETE CASCADE handles catalog_tools + tenant_integrations cleanup.

DELETE FROM "integration_catalog" WHERE "slug" = 'wix';
