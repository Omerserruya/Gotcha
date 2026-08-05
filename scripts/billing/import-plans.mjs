#!/usr/bin/env node
/**
 * Import a pricing catalogue export into a target environment. Idempotent.
 *
 * ── What it will never do ─────────────────────────────────────────────────
 * Delete a plan. Touch a subscription, invoice, usage row, customer or
 * provider event. Overwrite a production provider reference with the null the
 * export carries. A plan that exists in production but not in the file is
 * REPORTED and left exactly as it is; archiving one is a separate, deliberate
 * act, not a side effect of an import.
 *
 * ── Dry run is a real run ─────────────────────────────────────────────────
 * `--dry-run` executes the entire import inside BEGIN … ROLLBACK. Every
 * constraint, cast, enum and NOT NULL is exercised against real data and then
 * discarded. A dry run that passes is evidence the apply will work, rather
 * than a promise from a script that only rehearsed the easy half - and it
 * doubles as the transaction-rollback test.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 * Plans upsert on (key, version); entitlements on (plan, entitlementKey);
 * volume options on (plan, key); credit packages on key. No id from the source
 * environment is ever used. Subscriptions reference a plan by (planKey,
 * planVersion) rather than by id, so an upsert on that same natural key cannot
 * orphan one - which the safety checks verify rather than assume.
 *
 * Usage:
 *   node scripts/billing/import-plans.mjs --file data/production/plans-from-dev.json \
 *     --target prod --dry-run --confirm-source=dev
 *
 *   node scripts/billing/import-plans.mjs --file data/production/plans-from-dev.json \
 *     --target prod --apply --confirm-source=dev
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { makeRunner, queryJson } from "./plan-transport.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const exact = args.find((a) => a.startsWith(`--${n}=`));
  if (exact) return exact.slice(n.length + 3);
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const FILE = opt("file");
const TARGET = opt("target", "prod");
const APPLY = flag("apply");
const DRY = flag("dry-run") || !APPLY;
const CONFIRM_SOURCE = opt("confirm-source");
const EXPECT_BASELINE = opt("expect-plan-count");

const problems = [];
const fail = (m) => problems.push(m);

if (!FILE) fail("--file is required");
if (APPLY && DRY && flag("dry-run")) fail("pass either --dry-run or --apply, not both");

// ── Load and verify the export ─────────────────────────────────────────────
let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`\n  cannot read ${FILE}: ${e.message}\n`);
  process.exit(1);
}

if (doc.kind !== "gotcha.pricing-catalogue") fail(`unexpected file kind: ${doc.kind}`);
if (doc.formatVersion !== 1) fail(`unsupported formatVersion: ${doc.formatVersion}`);

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
{
  const { checksum: given, exportedAt: _t, ...content } = doc;
  const actual = crypto.createHash("sha256").update(stableStringify(content)).digest("hex");
  if (given !== actual) fail(`checksum mismatch - the file was edited after export (expected ${given?.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
}

// The confirmation flag has to name the environment the file actually came
// from, so a stale file from somewhere else cannot be waved through.
if (APPLY && CONFIRM_SOURCE !== doc.sourceEnvironment) {
  fail(`--confirm-source=${doc.sourceEnvironment} is required to apply (got ${CONFIRM_SOURCE ?? "nothing"})`);
}

// ── Validate the content ───────────────────────────────────────────────────
const CURRENCIES = new Set(["USD", "ILS", "EUR"]);
const INTERVALS = new Set(["MONTHLY", "ANNUAL"]);
const STATUSES = new Set(["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED"]);
const KINDS = new Set(["PUBLIC", "CUSTOM", "POC", "TRIAL", "LEGACY"]);

const seen = new Set();
for (const p of doc.plans ?? []) {
  const id = `${p.key}@${p.version}`;
  if (seen.has(id)) fail(`duplicate plan in file: ${id}`);
  seen.add(id);
  if (!p.key || !/^[a-z0-9_]+$/.test(p.key)) fail(`invalid plan key: ${JSON.stringify(p.key)}`);
  if (!Number.isInteger(p.version) || p.version < 1) fail(`${id}: version must be a positive integer`);
  if (!CURRENCIES.has(p.currency)) fail(`${id}: unsupported currency ${p.currency}`);
  if (!INTERVALS.has(p.billing_interval)) fail(`${id}: invalid billing interval ${p.billing_interval}`);
  if (!STATUSES.has(p.status)) fail(`${id}: invalid status ${p.status}`);
  if (!KINDS.has(p.kind)) fail(`${id}: invalid kind ${p.kind}`);
  if (p.kind === "CUSTOM") fail(`${id}: CUSTOM plans belong to one organization and must never be imported`);
  if (p.base_price !== null && Number(p.base_price) < 0) fail(`${id}: negative base price`);
  if (p.base_price === null && !p.sales_only) fail(`${id}: no price but not marked sales_only`);
  if (p.included_ai_units < 0) fail(`${id}: negative included units`);
  for (const v of p.volume_options ?? []) {
    if (Number(v.additional_price) < 0) fail(`${id}/${v.key}: negative additional price`);
    if (v.daily_volume < 0 || v.monthly_volume < 0) fail(`${id}/${v.key}: negative volume`);
    if (!CURRENCIES.has(v.currency)) fail(`${id}/${v.key}: unsupported currency ${v.currency}`);
  }
  const ek = new Set();
  for (const e of p.entitlements ?? []) {
    if (ek.has(e.entitlement_key)) fail(`${id}: duplicate entitlement ${e.entitlement_key}`);
    ek.add(e.entitlement_key);
  }
}
const cpKeys = new Set();
for (const c of doc.creditPackages ?? []) {
  if (cpKeys.has(c.key)) fail(`duplicate credit package: ${c.key}`);
  cpKeys.add(c.key);
  if (Number(c.price) < 0 || c.units < 0) fail(`${c.key}: negative price or units`);
  if (!CURRENCIES.has(c.currency)) fail(`${c.key}: unsupported currency ${c.currency}`);
}

if (problems.length) {
  console.error("\n  ✗ REFUSING TO PROCEED\n");
  for (const p of problems) console.error(`    • ${p}`);
  console.error("");
  process.exit(1);
}

// ── Connect and run the environment guards ─────────────────────────────────
const runner = makeRunner(TARGET);
console.log(`\n  file            ${FILE}`);
console.log(`  from            ${doc.sourceEnvironment} @ ${doc.schemaVersion} (${doc.scope})`);
console.log(`  target          ${runner.label}`);
console.log(`  mode            ${APPLY ? "APPLY" : "DRY RUN (executes, then rolls back)"}\n`);

const guards = [];
const guard = (ok, label, detail = "") => { guards.push({ ok, label, detail }); if (!ok) fail(`${label}${detail ? ` - ${detail}` : ""}`); };

// Schema parity. Importing into a different schema is how a column silently
// stops being written.
const targetSchema = runner.sql("select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1;").trim();
guard(targetSchema === doc.schemaVersion, "schema matches the export", `target ${targetSchema}, file ${doc.schemaVersion}`);

// The target must not be the source. Re-importing Dev into Dev is harmless but
// almost certainly a mistake, and worth stopping.
if (APPLY && TARGET === doc.sourceEnvironment) {
  guard(false, "target differs from source", `both are ${TARGET}`);
} else {
  guard(true, "target differs from source");
}

const baseline = Number(runner.sql("select count(*) from plans;").trim());
if (EXPECT_BASELINE !== null) {
  guard(baseline === Number(EXPECT_BASELINE), "baseline plan count as expected", `found ${baseline}, expected ${EXPECT_BASELINE}`);
} else {
  guards.push({ ok: true, label: "baseline plan count", detail: `${baseline} (no --expect-plan-count given)` });
}

// Subscriptions resolve a plan by (planKey, planVersion). Any that already
// fail to resolve are pre-existing breakage, and this import must not be
// blamed for them - but it must not create any either.
const orphansBefore = Number(runner.sql(`
  select count(*) from subscriptions s
  where not exists (select 1 from plans p where p.key = s.plan_key and p.version = s.plan_version);`).trim());
guard(orphansBefore === 0, "no subscriptions are currently orphaned", orphansBefore ? `${orphansBefore} already orphaned before this import` : "");

// A key that exists with an incompatible kind is a collision, not an update.
const existing = queryJson(runner, `
  select coalesce(json_agg(x order by x.key, x.version), '[]'::json) from (
    select key, version, name, status::text, kind::text, billing_interval::text as billing_interval,
           base_price::text, currency, included_ai_units, sales_only, active, sort_order, recommended
    from plans) x;`) ?? [];
const byNat = new Map(existing.map((p) => [`${p.key}@${p.version}`, p]));
for (const p of doc.plans ?? []) {
  const cur = byNat.get(`${p.key}@${p.version}`);
  if (cur && cur.kind !== p.kind) {
    guard(false, "no plan-kind collision", `${p.key} v${p.version} is ${cur.kind} in target, ${p.kind} in file`);
  }
}
if (!guards.some((g) => g.label === "no plan-kind collision")) {
  guards.push({ ok: true, label: "no plan-kind collision", detail: "" });
}

console.log("  Safety checks");
for (const g of guards) console.log(`    ${g.ok ? "✓" : "✗"} ${g.label}${g.detail ? ` - ${g.detail}` : ""}`);

if (problems.length) {
  console.error("\n  ✗ REFUSING TO PROCEED\n");
  for (const p of problems) console.error(`    • ${p}`);
  console.error("");
  process.exit(1);
}

// ── Diff ───────────────────────────────────────────────────────────────────
const COMPARE = ["name", "status", "kind", "billing_interval", "base_price", "currency",
                 "included_ai_units", "sales_only", "active", "sort_order", "recommended"];
const creates = [], updates = [], unchanged = [];
for (const p of doc.plans ?? []) {
  const cur = byNat.get(`${p.key}@${p.version}`);
  if (!cur) { creates.push(p); continue; }
  const changed = COMPARE.filter((f) => String(cur[f]) !== String(p[f]));
  if (changed.length) updates.push({ plan: p, cur, changed }); else unchanged.push(p);
}
const inFile = new Set((doc.plans ?? []).map((p) => `${p.key}@${p.version}`));
const productionOnly = existing.filter((p) => !inFile.has(`${p.key}@${p.version}`));

console.log("\n  Plan changes");
for (const p of creates) console.log(`    + CREATE  ${p.key} v${p.version}  ${p.base_price ?? "sales-only"} ${p.currency}  (${p.entitlements.length} ent, ${p.volume_options.length} vol)`);
for (const u of updates) {
  console.log(`    ~ UPDATE  ${u.plan.key} v${u.plan.version}`);
  for (const f of u.changed) console.log(`        ${f}: ${JSON.stringify(u.cur[f])} → ${JSON.stringify(u.plan[f])}`);
}
for (const p of unchanged) console.log(`    = SAME    ${p.key} v${p.version}`);
if (!creates.length && !updates.length && !unchanged.length) console.log("    (none)");

if (productionOnly.length) {
  console.log(`\n  Target-only plans (${productionOnly.length}) - NOT touched, NOT deleted`);
  for (const p of productionOnly) console.log(`    ! ${p.key} v${p.version} (${p.status}/${p.kind}) - archiving requires a separate, deliberate change`);
}

// ── Build the script ───────────────────────────────────────────────────────
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const bool = (v) => (v ? "true" : "false");
const json = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const planRef = (p) => `(select id from plans where key = ${q(p.key)} and version = ${p.version})`;

const sql = ["BEGIN;"];
for (const p of doc.plans ?? []) {
  sql.push(`
INSERT INTO plans (id, key, version, name, name_he, status, kind, billing_interval, base_price, currency,
                   included_ai_units, sales_only, active, description_en, description_he, sort_order,
                   recommended, support_level, data_retention_days, auto_purchase_eligible,
                   credit_packages_eligible, chat_volume_enabled, voice_volume_enabled, internal_note,
                   created_at, updated_at)
VALUES (gen_random_uuid()::text, ${q(p.key)}, ${p.version}, ${q(p.name)}, ${q(p.name_he)},
        ${q(p.status)}::"PlanStatus", ${q(p.kind)}::"PlanKind", ${q(p.billing_interval)}::"BillingInterval",
        ${num(p.base_price)}, ${q(p.currency)}, ${p.included_ai_units}, ${bool(p.sales_only)}, ${bool(p.active)},
        ${q(p.description_en)}, ${q(p.description_he)}, ${p.sort_order}, ${bool(p.recommended)},
        ${q(p.support_level)}, ${num(p.data_retention_days)}, ${bool(p.auto_purchase_eligible)},
        ${bool(p.credit_packages_eligible)}, ${bool(p.chat_volume_enabled)}, ${bool(p.voice_volume_enabled)},
        ${q(p.internal_note)}, now(), now())
ON CONFLICT (key, version) DO UPDATE SET
  name = EXCLUDED.name, name_he = EXCLUDED.name_he, status = EXCLUDED.status, kind = EXCLUDED.kind,
  billing_interval = EXCLUDED.billing_interval, base_price = EXCLUDED.base_price, currency = EXCLUDED.currency,
  included_ai_units = EXCLUDED.included_ai_units, sales_only = EXCLUDED.sales_only, active = EXCLUDED.active,
  description_en = EXCLUDED.description_en, description_he = EXCLUDED.description_he,
  sort_order = EXCLUDED.sort_order, recommended = EXCLUDED.recommended, support_level = EXCLUDED.support_level,
  data_retention_days = EXCLUDED.data_retention_days, auto_purchase_eligible = EXCLUDED.auto_purchase_eligible,
  credit_packages_eligible = EXCLUDED.credit_packages_eligible, chat_volume_enabled = EXCLUDED.chat_volume_enabled,
  voice_volume_enabled = EXCLUDED.voice_volume_enabled, internal_note = EXCLUDED.internal_note,
  updated_at = now();`);

  for (const e of p.entitlements ?? []) {
    sql.push(`
INSERT INTO plan_entitlements (id, plan_id, entitlement_key, value_type, value, created_at)
SELECT gen_random_uuid()::text, ${planRef(p)}, ${q(e.entitlement_key)},
       ${q(e.value_type)}::"EntitlementValueType", ${json(e.value)}, now()
ON CONFLICT (plan_id, entitlement_key) DO UPDATE SET
  value_type = EXCLUDED.value_type, value = EXCLUDED.value;`);
  }

  for (const v of p.volume_options ?? []) {
    sql.push(`
INSERT INTO plan_volume_options (id, plan_id, key, channel, daily_volume, business_days_per_month,
                                 monthly_volume, credits_per_unit, additional_credits, additional_price,
                                 currency, is_default, sort_order, enabled, internal_note, created_at, updated_at)
SELECT gen_random_uuid()::text, ${planRef(p)}, ${q(v.key)}, ${q(v.channel)}::"VolumeChannel",
       ${v.daily_volume}, ${v.business_days_per_month}, ${v.monthly_volume}, ${num(v.credits_per_unit)},
       ${v.additional_credits}, ${num(v.additional_price)}, ${q(v.currency)}, ${bool(v.is_default)},
       ${v.sort_order}, ${bool(v.enabled)}, ${q(v.internal_note)}, now(), now()
ON CONFLICT (plan_id, key) DO UPDATE SET
  channel = EXCLUDED.channel, daily_volume = EXCLUDED.daily_volume,
  business_days_per_month = EXCLUDED.business_days_per_month, monthly_volume = EXCLUDED.monthly_volume,
  credits_per_unit = EXCLUDED.credits_per_unit, additional_credits = EXCLUDED.additional_credits,
  additional_price = EXCLUDED.additional_price, currency = EXCLUDED.currency,
  is_default = EXCLUDED.is_default, sort_order = EXCLUDED.sort_order, enabled = EXCLUDED.enabled,
  internal_note = EXCLUDED.internal_note, updated_at = now();`);
  }
}

for (const c of doc.creditPackages ?? []) {
  // provider_price_ref: COALESCE keeps whatever production already holds. The
  // export always carries null, so without this an import would erase a
  // production payment reference that was set by hand.
  sql.push(`
INSERT INTO credit_packages (id, key, name, name_he, units, price, currency, status, eligible_plan_keys,
                             expiry_policy, expiry_days, customer_visible, max_purchase_quantity,
                             discount_label, sort_order, internal_note, provider_price_ref, active,
                             created_at, updated_at)
VALUES (gen_random_uuid()::text, ${q(c.key)}, ${q(c.name)}, ${q(c.name_he)}, ${c.units}, ${num(c.price)},
        ${q(c.currency)}, ${q(c.status)}::"PlanStatus",
        ${c.eligible_plan_keys ? json(c.eligible_plan_keys) : "NULL"},
        ${q(c.expiry_policy)}::"CreditExpiryPolicy", ${num(c.expiry_days)}, ${bool(c.customer_visible)},
        ${num(c.max_purchase_quantity)}, ${q(c.discount_label)}, ${c.sort_order}, ${q(c.internal_note)},
        NULL, true, now(), now())
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, name_he = EXCLUDED.name_he, units = EXCLUDED.units, price = EXCLUDED.price,
  currency = EXCLUDED.currency, status = EXCLUDED.status, eligible_plan_keys = EXCLUDED.eligible_plan_keys,
  expiry_policy = EXCLUDED.expiry_policy, expiry_days = EXCLUDED.expiry_days,
  customer_visible = EXCLUDED.customer_visible, max_purchase_quantity = EXCLUDED.max_purchase_quantity,
  discount_label = EXCLUDED.discount_label, sort_order = EXCLUDED.sort_order,
  internal_note = EXCLUDED.internal_note,
  provider_price_ref = COALESCE(credit_packages.provider_price_ref, EXCLUDED.provider_price_ref),
  updated_at = now();`);
}

// Estimation config has no natural unique key, so insert one only when the
// target has no active GLOBAL row. Replacing a live one would restate the
// commercial assumption every published volume option was priced against.
for (const e of doc.estimationConfigs ?? []) {
  sql.push(`
INSERT INTO public_estimation_configs (id, scope, version, chat_credits_per_estimated_conversation,
                                       voice_credits_per_estimated_call, business_days_per_month,
                                       active, internal_note, effective_from, created_at)
SELECT gen_random_uuid()::text, 'GLOBAL'::"EstimationScope", ${e.version}, ${num(e.chat_credits)},
       ${num(e.voice_credits)}, ${e.business_days_per_month}, true, ${q(e.internal_note)}, now(), now()
WHERE NOT EXISTS (select 1 from public_estimation_configs where scope = 'GLOBAL' and active = true);`);
}

// Post-condition, checked inside the transaction: the import must not have
// orphaned a subscription. Raising here rolls the whole thing back.
sql.push(`
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM subscriptions s
   WHERE NOT EXISTS (SELECT 1 FROM plans p WHERE p.key = s.plan_key AND p.version = s.plan_version);
  IF n > 0 THEN RAISE EXCEPTION 'import would orphan % subscription(s)', n; END IF;
END $$;`);

sql.push(DRY ? "ROLLBACK;" : "COMMIT;");
const script = sql.join("\n");

if (flag("print-sql")) {
  console.log("\n----- SQL -----\n" + script + "\n---------------\n");
}

// ── Execute ────────────────────────────────────────────────────────────────
console.log(`\n  ${DRY ? "Executing inside a transaction and rolling back…" : "Applying…"}`);
try {
  runner.sql(script);
} catch (e) {
  console.error(`\n  ✗ ${DRY ? "DRY RUN FAILED" : "IMPORT FAILED"} - the transaction was rolled back, nothing changed.\n`);
  const detail = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n").slice(0, 12);
  for (const l of detail) console.error(`    ${l}`);
  console.error("");
  process.exit(1);
}

if (DRY) {
  console.log("\n  ✓ DRY RUN PASSED - the import executed cleanly and was rolled back.");
  console.log("    Nothing changed. Re-run with --apply --confirm-source=" + doc.sourceEnvironment + " to commit.\n");
  process.exit(0);
}

// ── Verify what actually landed ────────────────────────────────────────────
const after = Number(runner.sql("select count(*) from plans;").trim());
const orphansAfter = Number(runner.sql(`
  select count(*) from subscriptions s
  where not exists (select 1 from plans p where p.key = s.plan_key and p.version = s.plan_version);`).trim());

console.log(`\n  ✓ APPLIED`);
console.log(`    plans      ${baseline} → ${after}`);
console.log(`    created    ${creates.length}`);
console.log(`    updated    ${updates.length}`);
console.log(`    unchanged  ${unchanged.length}`);
console.log(`    orphaned subscriptions ${orphansAfter}`);

if (orphansAfter !== 0) {
  console.error("\n  ✗ post-check failed: subscriptions are orphaned after the import.\n");
  process.exit(1);
}

// audit_logs is tenant-scoped (tenant_id NOT NULL), so a catalogue-level import
// has no honest row to write there. Recorded plainly rather than inventing a
// tenant id to satisfy the shape.
console.log("\n    note: audit_logs is tenant-scoped, so no audit row was written for this");
console.log("          catalogue-level change. The export checksum below identifies it.");
console.log(`          checksum ${doc.checksum}\n`);
