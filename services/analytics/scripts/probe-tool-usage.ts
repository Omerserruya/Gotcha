/**
 * getToolUsageStats probe - real tenant, real historical data, no fixtures.
 *
 * Calls the aggregation directly rather than over HTTP because `analytics`
 * deliberately holds no INTERNAL_SERVICE_KEY (nothing calls it service-to-
 * service; it is a browser-facing read). The route layer is unchanged by this
 * commit, so the function IS the change under test.
 *
 * CONTROL: the totals are reconciled against the raw tables. A probe that only
 * printed the aggregation would look identical whether it read one source or
 * two - the check is that what comes out equals what is actually stored.
 */
import { prisma } from "@chatcenter/shared";
import { getToolUsageStats } from "../src/services/analytics.service";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";

async function main() {
  const rows = await getToolUsageStats(TENANT, "2020-01-01", "2030-01-01");
  console.log(`tools returned: ${rows.length}`);
  console.log(`${"tool".padEnd(32)} ${"n".padStart(5)} ${"ok%".padStart(4)} ${"ok".padStart(5)} ${"refu".padStart(5)} ${"err".padStart(4)} ${"uncl".padStart(5)}`);
  for (const r of rows.slice(0, 12)) {
    console.log(
      `${r.toolName.slice(0, 32).padEnd(32)} ${String(r.executionCount).padStart(5)} ${String(r.successRate).padStart(4)} ${String(r.successCount).padStart(5)} ${String(r.refusedCount).padStart(5)} ${String(r.erroredCount).padStart(4)} ${String(r.unclassifiedFailureCount).padStart(5)}`,
    );
  }

  // CONTROL - reconcile against the raw tables.
  const auditTotal = await prisma.auditLog.count({ where: { tenantId: TENANT, action: { startsWith: "adapter." } } });
  const execTotal = await prisma.toolExecution.count({ where: { tenantId: TENANT } });
  const aggTotal = rows.reduce((s, r) => s + r.executionCount, 0);
  const aggOk = rows.reduce((s, r) => s + r.successCount, 0);
  const auditOk = await prisma.auditLog.count({ where: { tenantId: TENANT, action: { startsWith: "adapter.ok" } } });

  console.log(`\nCONTROL  aggregated=${aggTotal}  audit=${auditTotal} + toolExecution=${execTotal} = ${auditTotal + execTotal}`);
  console.log(`CONTROL  aggregated ok=${aggOk}  audit ok rows=${auditOk}`);

  const fail: string[] = [];
  if (aggTotal !== auditTotal + execTotal) fail.push(`total ${aggTotal} != ${auditTotal + execTotal}`);
  if (aggOk !== auditOk) fail.push(`ok ${aggOk} != ${auditOk}`);
  if (rows.length < 2) fail.push(`only ${rows.length} tools - grouping collapsed`);
  if (rows.some((r) => r.toolName === "unknown" && r.executionCount > 10)) fail.push("large 'unknown' bucket - naming failed");

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error("PROBE ERROR", e); process.exit(1); });
