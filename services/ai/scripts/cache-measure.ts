/** Cache A/B measurement: per-reasoner-call input vs cached tokens for a conversation. */
import { prisma } from "@chatcenter/shared";
(async () => {
  const conv = process.argv[2];
  const rows: any[] = await (prisma as any).aIUsageLog.findMany({
    where: { conversationId: conv },
    orderBy: { createdAt: "asc" },
    select: { requestType: true, inputTokens: true, cachedInputTokens: true, latencyMs: true, createdAt: true },
  }).catch(async () => {
    // fallback table name
    return (prisma as any).usageLog?.findMany?.({ where: { conversationId: conv }, orderBy: { createdAt: "asc" } }) ?? [];
  });
  let inSum = 0, cachedSum = 0, n = 0;
  for (const r of rows) {
    inSum += r.inputTokens ?? 0; cachedSum += r.cachedInputTokens ?? 0; n++;
    console.log(`  ${r.requestType ?? "?"} in=${r.inputTokens} cached=${r.cachedInputTokens} latency=${r.latencyMs ?? "-"}ms`);
  }
  console.log(`TOTAL calls=${n} inputTokens=${inSum} cachedTokens=${cachedSum} hitRate=${inSum ? ((cachedSum / inSum) * 100).toFixed(1) : 0}%`);
  await prisma.$disconnect();
})();
