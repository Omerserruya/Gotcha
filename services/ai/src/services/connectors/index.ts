/**
 * Adapter registry — importing this module triggers registerAdapter()
 * calls for every shipped adapter.
 *
 * The runtime entry point (services/ai/src/index.ts) imports this file
 * once at startup so the framework knows about every provider before the
 * first request lands.
 *
 * Adding a new provider:
 *   1. Create `services/ai/src/services/connectors/<provider>.adapter.ts`.
 *   2. Implement ProviderAdapter from integration-framework.ts.
 *   3. Call `registerAdapter(...)` at the bottom of the file.
 *   4. Add an `import` line below.
 *   5. Seed an `IntegrationCatalog` row + add the OAuth/API-key route.
 */

import "./stripe.adapter";
import "./hubspot.adapter";
import "./shopify.adapter";
import "./airtable.adapter";
import "./postgres.adapter";
import "./mongodb.adapter";
// Wix temporarily disabled — re-enable by uncommenting + restoring the
// catalog row + OAuth routes (see docs/setup/marketplace-oauth-setup-guide.md).
// import "./wix.adapter";
import "./woocommerce.adapter";
import "./paypal.adapter";
// Square temporarily disabled — re-enable by uncommenting + restoring the
// catalog row + OAuth routes (see docs/setup/marketplace-oauth-setup-guide.md).
// import "./square.adapter";
import "./salesforce.adapter";
import "./monday.adapter";
import "./aws-rds.adapter";

export { listAdapters, getAdapter, executeAdapterTool, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
