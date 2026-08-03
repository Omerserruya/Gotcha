#!/usr/bin/env node
/**
 * Export the pricing catalogue from Dev into a reviewable JSON file.
 *
 * What this exports is the CATALOGUE and nothing else: plans, their
 * entitlements, their volume options, the estimation config those options were
 * priced against, and the credit packages. No tenant, no subscription, no
 * invoice, no usage, no customer, no provider event, no audit row.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 * Database ids are cuids and are NOT exported. A plan's identity here is
 * (key, version), which is the unique constraint the schema already declares,
 * so an import can find its counterpart without either side agreeing on ids.
 * Entitlements key on (plan, entitlementKey) and volume options on (plan, key),
 * for the same reason.
 *
 * ── What is deliberately dropped ──────────────────────────────────────────
 *   tenantId          CUSTOM plans belong to one organization. That id names a
 *                     Dev tenant; in production it would dangle.
 *   publishedBy       Dev user ids. Meaningless in production, and importing
 *   approvedBy        them would attribute a commercial decision to a person
 *   createdBy         who never made it.
 *   timestamps        created/updated/published/approved are facts about the
 *                     Dev row, not about the plan.
 *   providerPriceRef  environment-specific payment identifier (see below).
 *
 * ── Provider identifiers ──────────────────────────────────────────────────
 * No plan table carries one. `credit_packages.provider_price_ref` is the only
 * such column in the catalogue, and every Dev row has it NULL. It is exported
 * as null regardless, and the importer never overwrites a non-null production
 * value with it - so a production reference, once set by hand, survives every
 * later import.
 *
 * ── Default scope ─────────────────────────────────────────────────────────
 * ACTIVE plans only. RETIRED versions exist so that subscriptions sold against
 * an old price keep resolving; a production database with no subscriptions has
 * nothing for them to serve, and copying them would be seeding history that
 * never happened. `--include-retired` opts in.
 *
 * Usage:
 *   node scripts/billing/export-plans.mjs --output data/production/plans-from-dev.json
 *   node scripts/billing/export-plans.mjs --include-retired --output /tmp/all.json
 *   node scripts/billing/export-plans.mjs --sql-preview /tmp/plans.sql
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeRunner, queryJson, migrationHead } from "./plan-transport.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUTPUT = opt("output", "data/production/plans-from-dev.json");
const SQL_PREVIEW = opt("sql-preview");
const INCLUDE_RETIRED = flag("include-retired");
const SOURCE = opt("source", "dev");

const STATUS_FILTER = INCLUDE_RETIRED
  ? "p.status in ('ACTIVE','RETIRED')"
  : "p.status = 'ACTIVE'";

const runner = makeRunner(SOURCE);
console.log(`  source          ${runner.label}`);

const schemaVersion = migrationHead(runner);
console.log(`  schema version  ${schemaVersion}`);

// ── Plans, with their children nested ──────────────────────────────────────
// Ordering is explicit at every level. An export whose row order depends on
// the planner produces a different checksum for identical data, and then the
// diff everyone relies on is noise.
const plans = queryJson(runner, `
select coalesce(json_agg(x order by x.sort_order, x.key, x.version), '[]'::json) from (
  select
    p.key, p.version, p.name, p.name_he, p.status::text, p.kind::text,
    p.billing_interval::text as billing_interval,
    p.base_price::text, p.currency, p.included_ai_units, p.sales_only, p.active,
    p.description_en, p.description_he, p.sort_order, p.recommended,
    p.support_level, p.data_retention_days,
    p.auto_purchase_eligible, p.credit_packages_eligible,
    p.chat_volume_enabled, p.voice_volume_enabled, p.internal_note,
    (select coalesce(json_agg(e order by e.entitlement_key), '[]'::json) from (
       select entitlement_key, value_type::text as value_type, value
       from plan_entitlements where plan_id = p.id
     ) e) as entitlements,
    (select coalesce(json_agg(v order by v.sort_order, v.key), '[]'::json) from (
       select key, channel::text as channel, daily_volume, business_days_per_month,
              monthly_volume, credits_per_unit::text, additional_credits,
              additional_price::text, currency, is_default, sort_order, enabled,
              internal_note
       from plan_volume_options where plan_id = p.id
     ) v) as volume_options
  from plans p
  where ${STATUS_FILTER}
    and p.tenant_id is null      -- CUSTOM plans are one organization's, never catalogue
) x;`);

// ── Credit packages ────────────────────────────────────────────────────────
const creditPackages = queryJson(runner, `
select coalesce(json_agg(x order by x.sort_order, x.key), '[]'::json) from (
  select key, name, name_he, units, price::text, currency, status::text,
         eligible_plan_keys, expiry_policy::text, expiry_days, customer_visible,
         max_purchase_quantity, discount_label, sort_order, internal_note
  from credit_packages where status = 'ACTIVE'
) x;`);

// ── Estimation config ──────────────────────────────────────────────────────
// GLOBAL scope only. PLAN and VOLUME_OPTION scoped rows point at ids, and Dev
// has none of them; if that changes they need their own mapping rather than a
// silent guess.
const estimation = queryJson(runner, `
select coalesce(json_agg(x order by x.version desc), '[]'::json) from (
  select scope::text, version,
         chat_credits_per_estimated_conversation::text as chat_credits,
         voice_credits_per_estimated_call::text as voice_credits,
         business_days_per_month, active, internal_note
  from public_estimation_configs where scope = 'GLOBAL' and active = true
) x;`);

const scopedEstimation = queryJson(runner,
  "select count(*)::int from public_estimation_configs where scope <> 'GLOBAL';");
if (scopedEstimation > 0) {
  console.log(`  NOTE: ${scopedEstimation} plan/volume-scoped estimation rows are NOT exported (id-bound).`);
}

// Credit packages carry the one provider reference in the catalogue. Export it
// as an explicit null so the file documents that the mapping is manual.
for (const cp of creditPackages) cp.providerPriceRef = null;

const payload = {
  kind: "gotcha.pricing-catalogue",
  formatVersion: 1,
  schemaVersion,
  sourceEnvironment: SOURCE,
  scope: INCLUDE_RETIRED ? "active+retired" : "active-only",
  exportedAt: new Date().toISOString(),
  counts: {
    plans: plans.length,
    entitlements: plans.reduce((n, p) => n + p.entitlements.length, 0),
    volumeOptions: plans.reduce((n, p) => n + p.volume_options.length, 0),
    creditPackages: creditPackages.length,
    estimationConfigs: estimation.length,
  },
  notes: [
    "Database ids are not exported. Plans key on (key, version).",
    "tenantId, publishedBy, approvedBy, createdBy and all timestamps are omitted.",
    "credit_packages.providerPriceRef is exported as null; production values are set by hand and never overwritten by an import.",
  ],
  plans,
  creditPackages,
  estimationConfigs: estimation,
};

/** Checksum over the content only, so re-exporting identical data matches. */
function checksum(obj) {
  const { checksum: _drop, exportedAt: _t, ...content } = obj;
  return crypto.createHash("sha256").update(stableStringify(content)).digest("hex");
}
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
payload.checksum = checksum(payload);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n");

console.log(`\n  plans           ${payload.counts.plans}`);
console.log(`  entitlements    ${payload.counts.entitlements}`);
console.log(`  volume options  ${payload.counts.volumeOptions}`);
console.log(`  credit packages ${payload.counts.creditPackages}`);
console.log(`  estimation      ${payload.counts.estimationConfigs} (GLOBAL)`);
console.log(`  checksum        ${payload.checksum.slice(0, 16)}…`);
console.log(`\n  written to ${OUTPUT}\n`);
for (const p of plans) {
  const price = p.base_price === null ? "sales-only" : `${p.base_price} ${p.currency}`;
  console.log(`    ${p.key} v${p.version}  ${p.status}/${p.kind}  ${price}  units=${p.included_ai_units}  ent=${p.entitlements.length}  vol=${p.volume_options.length}`);
}

// ── Optional SQL preview, for reviewers who would rather read SQL ──────────
if (SQL_PREVIEW) {
  const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const lines = [
    "-- Generated by scripts/billing/export-plans.mjs for REVIEW ONLY.",
    "-- Not the import path: import-plans.mjs upserts inside a transaction",
    "-- and preserves production-only rows. Do not run this by hand.",
    "",
  ];
  for (const p of plans) {
    lines.push(`-- ${p.key} v${p.version} (${p.status}/${p.kind})`);
    lines.push(
      `INSERT INTO plans (id, key, version, name, status, kind, billing_interval, base_price, currency, included_ai_units, sales_only, active, sort_order, recommended)`,
      `VALUES (gen_random_uuid()::text, ${q(p.key)}, ${p.version}, ${q(p.name)}, ${q(p.status)}::"PlanStatus", ${q(p.kind)}::"PlanKind", ${q(p.billing_interval)}::"BillingInterval", ${p.base_price ?? "NULL"}, ${q(p.currency)}, ${p.included_ai_units}, ${p.sales_only}, ${p.active}, ${p.sort_order}, ${p.recommended})`,
      `ON CONFLICT (key, version) DO UPDATE SET name = EXCLUDED.name, base_price = EXCLUDED.base_price;`,
      `-- + ${p.entitlements.length} entitlements, ${p.volume_options.length} volume options`,
      "",
    );
  }
  fs.mkdirSync(path.dirname(SQL_PREVIEW), { recursive: true });
  fs.writeFileSync(SQL_PREVIEW, lines.join("\n"));
  console.log(`  SQL preview written to ${SQL_PREVIEW} (review only, not the import path)\n`);
}
