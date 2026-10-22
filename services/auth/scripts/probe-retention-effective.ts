/**
 * GET /retention must report the EFFECTIVE policy, not the stored rows.
 *
 * Four shapes, and the two middle ones are the whole reason for the change
 * because neither can occur today:
 *
 *   tenant      an enabled row wins            source=tenant        purging=true
 *   default     NO row + env default set       source=platform_default purging=true
 *   overridden  a DISABLED row + env default   source=platform_default purging=true
 *                                              overriddenByPlatformDefault=true
 *   none        no row, no default             source=none          purging=false
 *
 * `overridden` is the dangerous one: the engine selects policies
 * `where: {enabled:true}` and builds its "covered" set from that, so disabling
 * a policy does NOT stop deletion - it falls back to the platform's number. A
 * response that showed only the stored row would tell someone who turned
 * retention off that they had succeeded.
 *
 * The env var is set in THIS PROCESS before the route is imported, so the probe
 * proves the read path without changing any deployed configuration.
 */
process.env.RETENTION_DEFAULT_AUDIT_LOGS_DAYS = "400";
process.env.RETENTION_DEFAULT_AGENT_LOOP_RUNS_DAYS = "30";

import { prisma } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";

async function cleanup() {
  await prisma.dataRetentionPolicy
    .deleteMany({ where: { tenantId: TENANT, category: { in: ["messages", "agent_loop_runs"] } } })
    .catch((e: any) => console.warn("cleanup:", e?.message ?? e));
}

async function main() {
  await cleanup();
  // tenant: an ENABLED row, no env default for this category
  await prisma.dataRetentionPolicy.create({
    data: { tenantId: TENANT, category: "messages", retentionDays: 180, enabled: true } as any,
  });
  // overridden: a DISABLED row, WITH an env default
  await prisma.dataRetentionPolicy.create({
    data: { tenantId: TENANT, category: "agent_loop_runs", retentionDays: 7, enabled: false } as any,
  });

  const { default: router } = await import("../src/routes/gdpr");
  const layer: any = (router as any).stack.find(
    (l: any) => l.route?.path === "/retention" && l.route?.methods?.get,
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  let payload: any = null;
  await handler(
    { tenantId: TENANT, user: { userId: "probe", role: "SYSTEM_ADMIN" }, query: {}, params: {} } as any,
    { json: (b: any) => { payload = b; }, status: () => ({ json: (b: any) => { payload = b; } }) } as any,
  );

  const by = new Map<string, any>((payload?.data ?? []).map((r: any) => [r.category, r]));
  const fail: string[] = [];
  for (const c of ["messages", "audit_logs", "agent_loop_runs", "usage_logs"]) {
    const r = by.get(c);
    console.log(
      `${c.padEnd(24)} days=${String(r?.retentionDays).padStart(4)} source=${String(r?.source).padEnd(17)} purging=${String(r?.purging).padEnd(5)} overridden=${r?.overriddenByPlatformDefault}`,
    );
  }

  const m = by.get("messages"), a = by.get("audit_logs"), g = by.get("agent_loop_runs"), u = by.get("usage_logs");
  if ((payload?.data ?? []).length !== 6) fail.push(`expected all 6 categories, got ${(payload?.data ?? []).length}`);
  if (m?.source !== "tenant" || m?.retentionDays !== 180) fail.push("enabled tenant row did not win");
  if (a?.source !== "platform_default" || a?.retentionDays !== 400) fail.push("env default not reported for a category with no row");
  if (!a?.purging) fail.push("env-default category not reported as purging");
  if (g?.source !== "platform_default" || g?.retentionDays !== 30) fail.push("DISABLED row did not fall back to the platform default");
  if (!g?.overriddenByPlatformDefault) fail.push("disabled-but-still-purging was not flagged");
  if (g?.configured?.enabled !== false) fail.push("the disabled row itself is no longer visible");
  if (u?.source !== "none" || u?.purging !== false) fail.push("category with neither should report none/false");

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup();
  process.exit(fail.length === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("PROBE ERROR", e); await cleanup(); process.exit(1); });
