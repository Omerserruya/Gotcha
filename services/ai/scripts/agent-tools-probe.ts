/** One-off: what action tools does the pilot agent actually have enabled? Decides
 *  whether a calendar-only employee exists for the first kernel cutover. */
import { prisma } from "@chatcenter/shared";
const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142";
async function main() {
  const perms: any[] = await (prisma as any).agentToolPermission.findMany({
    where: { tenantId: TENANT_ID, aiAgentId: AGENT_ID, isAllowed: true },
    include: { tenantTool: { include: { catalogTool: { select: { slug: true } }, tenantIntegration: { include: { integration: { select: { slug: true } } } } } } },
  });
  console.log(`\nagent ${AGENT_ID} — allowed AgentToolPermission rows: ${perms.length}`);
  for (const p of perms) {
    const tt = p.tenantTool;
    console.log(`  - ${tt?.tenantIntegration?.integration?.slug ?? "?"}:${tt?.catalogTool?.slug ?? "?"} (enabled=${tt?.isEnabled}, integStatus=${tt?.tenantIntegration?.status})`);
  }
  // custom tools + connected integrations for full picture
  const integs: any[] = await (prisma as any).tenantIntegration.findMany({ where: { tenantId: TENANT_ID, status: "CONNECTED" }, include: { integration: { select: { slug: true, category: true } } } });
  console.log(`\nconnected integrations (tenant): ${integs.map((i) => `${i.integration?.slug}/${i.integration?.category}`).join(", ") || "(none)"}`);
  const mts: any[] = await (prisma as any).meetingType.findMany({ where: { tenantId: TENANT_ID, isActive: true }, select: { slug: true, agentTimezone: true } });
  console.log(`active meeting types: ${mts.map((m) => m.slug).join(", ") || "(none)"}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("PROBE FAILED:", e); await prisma.$disconnect(); process.exit(1); });
