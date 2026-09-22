/**
 * D51 probe - what a DELETE leaves behind.
 *
 * Builds a throwaway employee, points every known holder of an AI-agent id at
 * it, deletes it through the real HTTP route, and checks each holder.
 *
 * The cases are chosen so different wrong implementations fail differently:
 *
 *   canvas   a canvas-blind delete leaves targetId pointing at a dead id, and
 *            the flow executor then writes that id onto every new conversation.
 *            Fails ONLY this case - everything else looks clean.
 *   grants   per-agent tool permissions must go with the agent.
 *   usage    MUST SURVIVE, with its aiAgentId still populated. A delete that
 *            tidied these away would pass a "no dangling ids" check and destroy
 *            billing evidence, so this asserts the OPPOSITE of the others.
 *   name     usage rows must still be able to name the employee afterwards.
 *   other    a SECOND canvas node pointing at a DIFFERENT agent must be
 *            untouched. Without this, a statement that cleared the whole nodes
 *            array, or every route_target, would pass every case above.
 */
import { prisma } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const AGENT = "d51probe-agent";
const OTHER = "d51probe-other";
const KEY = process.env.INTERNAL_SERVICE_KEY ?? "";

async function canvasNodes(): Promise<any[]> {
  const row: any = await prisma.flowCanvas.findUnique({ where: { tenantId: TENANT } });
  return Array.isArray(row?.nodes) ? row.nodes : [];
}

async function cleanup(original: any[] | null) {
  const log = (w: string) => (e: any) => console.warn(`cleanup ${w}:`, e?.message ?? e);
  await prisma.usageLog.deleteMany({ where: { tenantId: TENANT, aiAgentId: { in: [AGENT, OTHER] } } }).catch(log("usage"));
  await prisma.agentToolPermission.deleteMany({ where: { tenantId: TENANT, aiAgentId: { in: [AGENT, OTHER] } } }).catch(log("grants"));
  await prisma.aIAgent.deleteMany({ where: { tenantId: TENANT, id: { in: [AGENT, OTHER] } } }).catch(log("agents"));
  if (original) {
    await prisma.flowCanvas
      .update({ where: { tenantId: TENANT }, data: { nodes: original as any } })
      .catch(log("canvas restore"));
  }
}

async function main() {
  // The tenant's real canvas is restored verbatim at the end - this probe must
  // not leave the routing graph altered.
  const original = await canvasNodes();
  await cleanup(null);

  for (const id of [AGENT, OTHER]) {
    await prisma.aIAgent.create({
      data: { id, tenantId: TENANT, name: `D51 ${id}`, status: "ACTIVE" } as any,
    });
  }
  const catalogTool = await prisma.tenantTool.findFirst({ where: { tenantId: TENANT }, select: { id: true } });
  if (catalogTool) {
    await prisma.agentToolPermission.create({
      data: { tenantId: TENANT, aiAgentId: AGENT, tenantToolId: catalogTool.id, isAllowed: true } as any,
    });
  }
  await prisma.usageLog.create({
    data: { tenantId: TENANT, type: "ai_tokens", quantity: 1, tokensEquivalent: 10, aiAgentId: AGENT, metadata: { probe: true } } as any,
  });

  await prisma.flowCanvas.update({
    where: { tenantId: TENANT },
    data: {
      nodes: [
        ...original,
        { id: "d51-node-a", type: "route_target", position: { x: 0, y: 0 }, data: { targetId: AGENT, routeType: "agent" } },
        { id: "d51-node-b", type: "route_target", position: { x: 0, y: 0 }, data: { targetId: OTHER, routeType: "agent" } },
      ] as any,
    },
  });

  const res = await fetch(`http://localhost:4006/api/ai-agents/${AGENT}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${KEY}`, "x-tenant-id": TENANT },
  });
  const body: any = await res.json().catch(() => ({}));
  console.log(`DELETE -> ${res.status} ${JSON.stringify(body).slice(0, 120)}`);

  const fail: string[] = [];
  const nodes = await canvasNodes();
  const mine = nodes.find((n: any) => n?.id === "d51-node-a");
  const theirs = nodes.find((n: any) => n?.id === "d51-node-b");
  const usage = await prisma.usageLog.findMany({ where: { tenantId: TENANT, aiAgentId: AGENT } });
  const grants = await prisma.agentToolPermission.count({ where: { tenantId: TENANT, aiAgentId: AGENT } });
  const gone = await prisma.aIAgent.findUnique({ where: { id: AGENT } });

  console.log(`canvas  mine.targetId=${JSON.stringify(mine?.data?.targetId)}  other.targetId=${JSON.stringify(theirs?.data?.targetId)}`);
  console.log(`grants  remaining=${grants} (expect 0)`);
  console.log(`usage   rows=${usage.length} (expect 1, MUST survive)  aiAgentId=${usage[0]?.aiAgentId ?? "null"}`);
  console.log(`name    metadata.aiAgentName=${(usage[0]?.metadata as any)?.aiAgentName ?? "(absent)"}`);
  console.log(`agent   deleted=${gone === null}`);

  if (res.status !== 200) fail.push(`delete returned ${res.status}`);
  if (gone !== null) fail.push("agent not deleted");
  if (mine?.data?.targetId !== null) fail.push(`canvas target not cleared: ${JSON.stringify(mine?.data?.targetId)}`);
  if (theirs?.data?.targetId !== OTHER) fail.push("OTHER agent's canvas node was damaged");
  if (nodes.length !== original.length + 2) fail.push(`node count changed: ${nodes.length} vs ${original.length + 2}`);
  if (grants !== 0) fail.push(`${grants} tool grants survived`);
  if (usage.length !== 1) fail.push(`usage rows ${usage.length} != 1 - BILLING EVIDENCE DESTROYED`);
  if (usage[0] && usage[0].aiAgentId !== AGENT) fail.push("usage aiAgentId was cleared - attribution lost");
  if ((usage[0]?.metadata as any)?.aiAgentName !== `D51 ${AGENT}`) fail.push("usage row cannot name the deleted employee");

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup(original);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  await cleanup(null);
  process.exit(1);
});
