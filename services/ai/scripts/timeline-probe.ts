/** P1-5 probe — exercise the decision-timeline projection over real loop rows. */
import { prisma } from "@chatcenter/shared";

const [tenantId, conversationId] = process.argv.slice(2);

(async () => {
  const runs = await (prisma as any).agentLoopRun.findMany({
    where: { tenantId, conversationId }, orderBy: { createdAt: "asc" }, take: 100,
  });
  console.log("[timeline] runs:", runs.length);
  const loopIds = runs.map((r: any) => r.loopId);
  const iters = await (prisma as any).agentLoopIteration.findMany({
    where: { tenantId, loopId: { in: loopIds } }, orderBy: [{ loopId: "asc" }, { iteration: "asc" }],
  });
  for (const r of runs.slice(0, 2)) {
    console.log(`[timeline] run mode=${r.mode} goal=${r.goal} term=${r.terminationReason} iters=${r.iterationCount} units=${r.spentUnits}`);
    for (const it of iters.filter((i: any) => i.loopId === r.loopId).slice(0, 4)) {
      const o = it.observation as any;
      const obs = o == null ? "" : (typeof o === "string" ? o : `${o.operation ?? ""}→${o.status ?? ""}${o.data ? " data:" + String(o.data).slice(0, 40) : ""}`);
      console.log(`   #${it.iteration} ${it.decisionType} ${it.proposedOperation ?? "-"} ${it.runtimeResult ?? "-"} | ${obs}`);
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("[timeline] error:", e?.message || e); process.exit(1); });
