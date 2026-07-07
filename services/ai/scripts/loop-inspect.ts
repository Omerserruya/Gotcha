/** Dump a single conversation's latest loop run: per-iteration decision, reasoning,
 *  op, runtime result, observation — to root-cause a pathology. */
import { prisma } from "@chatcenter/shared";
const TENANT_ID = process.env.PILOT_TENANT_ID || "cmmov5qh10000ltnqm7pmxqzc";
async function main() {
  const conv = process.argv[2];
  const run: any = await (prisma as any).agentLoopRun.findFirst({ where: { tenantId: TENANT_ID, conversationId: conv }, orderBy: { createdAt: "desc" } });
  if (!run) { console.log("no run"); await prisma.$disconnect(); return; }
  console.log(`\nrun ${run.loopId} mode=${run.mode} term=${run.terminationReason} iters=${run.iterationCount} units=${run.spentUnits}`);
  console.log(`reply: ${run.reply}\n`);
  const its: any[] = await (prisma as any).agentLoopIteration.findMany({ where: { loopId: run.loopId }, orderBy: { iteration: "asc" } });
  for (const it of its) {
    console.log(`── iter ${it.iteration}: decision=${it.decisionType} op=${it.proposedOperation ?? "-"} rt=${it.runtimeResult ?? "-"}`);
    if (it.reasoningSummary) console.log(`   why: ${String(it.reasoningSummary).slice(0, 400)}`);
    if (it.observation) console.log(`   obs: ${JSON.stringify(it.observation).slice(0, 500)}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("FAIL:", e); await prisma.$disconnect(); process.exit(1); });
