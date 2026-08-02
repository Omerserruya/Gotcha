/**
 * One-off, idempotent backfill: migrate legacy PostConversationConfig.summaryFields
 * into the scope-aware FieldDefinition registry as REVIEW_REQUIRED fields.
 *
 * Usage (from services/ai):
 *   npm run backfill:summary-fields              # all tenants
 *   npm run backfill:summary-fields <tenantId>   # one tenant
 *
 * Safe to re-run: existing keys are skipped. Migrated fields land in
 * REVIEW_REQUIRED scope and are NOT routed/written until a human assigns a real
 * scope in the Fields Builder.
 */

import { backfillSummaryFieldsToRegistry, backfillAllTenants } from "../services/intelligence-registry.service";

async function main() {
  const tenantId = process.argv[2];
  if (tenantId) {
    const r = await backfillSummaryFieldsToRegistry(tenantId);
    console.log(`[backfill] tenant=${r.tenantId} created=${r.created.length} existed=${r.existed.length}`);
    if (r.created.length) console.log(`  created: ${r.created.join(", ")}`);
  } else {
    const results = await backfillAllTenants();
    const created = results.reduce((s, r) => s + r.created.length, 0);
    console.log(`[backfill] tenants=${results.length} fields_created=${created}`);
    for (const r of results.filter((x) => x.created.length)) {
      console.log(`  ${r.tenantId}: ${r.created.join(", ")}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
