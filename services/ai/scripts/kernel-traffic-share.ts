/**
 * MIGRATION METRIC — what share of production bot turns did the Kernel DRIVE (autonomous),
 * vs shadow (evidence-only, customer saw the legacy brain) vs legacy-only?
 *
 * The headline number for the migration: % of production traffic the Kernel handles.
 * `agent_loop_runs.mode = "autonomous"` = the Kernel drove the customer turn (real).
 * `= "advisory"/"shadow"` = shadow evaluation (customer saw Legacy). Total production
 * turns = ai.bot_turn audit rows. Windowed to the last N days.
 *
 *   ... npx tsx scripts/kernel-traffic-share.ts [days=7]
 */
import { prisma } from "@chatcenter/shared";

const TENANT_ID = process.env.PILOT_TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";

async function main() {
  const days = Number(process.argv[2] || "7");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totalTurns, runs] = await Promise.all([
    prisma.auditLog.count({ where: { tenantId: TENANT_ID, action: "ai.bot_turn", createdAt: { gte: since } } }),
    (prisma as any).agentLoopRun.findMany({ where: { tenantId: TENANT_ID, createdAt: { gte: since } }, select: { mode: true } }),
  ]);
  const byMode: Record<string, number> = {};
  for (const r of runs as any[]) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
  const autonomous = byMode["autonomous"] ?? 0;

  const pct = (n: number) => (totalTurns ? ((n / totalTurns) * 100).toFixed(1) : "0.0");
  console.log(`\n=== KERNEL PRODUCTION TRAFFIC SHARE (last ${days}d) ===`);
  console.log(`  production bot turns (ai.bot_turn):        ${totalTurns}`);
  console.log(`  kernel loop runs by mode:                  ${JSON.stringify(byMode)}`);
  console.log(`  ── Kernel DROVE the turn (autonomous):     ${autonomous}  (${pct(autonomous)}% of production)`);
  console.log(`  ── Kernel shadow-evaluated (legacy served): ${(byMode["advisory"] ?? 0) + (byMode["shadow"] ?? 0)}`);
  console.log(`\n  HEADLINE: Kernel handles ${pct(autonomous)}% of production bot traffic.`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("TRAFFIC-SHARE FAILED:", e); await prisma.$disconnect(); process.exit(1); });
