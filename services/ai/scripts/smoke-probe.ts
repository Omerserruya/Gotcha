console.log("[probe] start");
import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
console.log("[probe] prisma imported");

(async () => {
  console.log("[probe] querying...");
  const agent = await withCrossTenantAccess(async () =>
    await prisma.aIAgent.findFirst({ orderBy: { createdAt: "desc" } }),
  );
  console.log("[probe] result:", agent ? `${agent.id} ${agent.name}` : "null");
  await prisma.$disconnect();
  console.log("[probe] done");
})().catch((e) => { console.error("[probe] error:", e); process.exit(1); });
