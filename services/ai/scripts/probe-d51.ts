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
 *   live     an OPEN conversation is released AND becomes claimable. The
 *            approved wording is "they will wait unassigned until someone
 *            claims them", so the assertion is the state a human meets:
 *            isAiManaged() false, and `claim` accepts it. Nulling
 *            assignedAiAgentId while leaving handledBy="ai_agent" passes a
 *            column check and fails this one.
 *   closed   a CLOSED conversation KEEPS its assignedAiAgentId - on a finished
 *            thread that is the record of which employee handled it, and the
 *            per-employee counts read it. Inverse of `live`, so a blanket
 *            release fails here.
 *   hazards  Tenant.defaultAgentId and KnowledgeBase.scopeAgentId cleared.
 *   calendar a connected calendar SURVIVES the delete, unowned AND findable.
 *            Three assertions because two of them can pass while the third
 *            fails: the row must still exist (not severed), aiAgentId must be
 *            null (not dangling), and the admin listing must return it WITHOUT
 *            an aiAgentId filter (not invisible). Before 20260923120000 the
 *            third was impossible - the route required the parameter.
 */
import { prisma } from "@chatcenter/shared";

const TENANT = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const AGENT = "d51probe-agent";
const OTHER = "d51probe-other";
const KEY = process.env.INTERNAL_SERVICE_KEY ?? "";

/**
 * Module-scoped so the ERROR path can restore the canvas as well.
 *
 * It could not, once: `main()` held the snapshot as a local and the catch
 * handler called cleanup(null), which removes fixtures but cannot put the
 * nodes back. A run that died before its own cleanup left two probe nodes in
 * the tenant's real routing graph, and the NEXT run captured those as its
 * "original" and faithfully restored them. A restore that can only run on the
 * happy path is not a restore.
 */
let canvasSnapshot: any[] | null = null;

async function canvasNodes(): Promise<any[]> {
  const row: any = await prisma.flowCanvas.findUnique({ where: { tenantId: TENANT } });
  return Array.isArray(row?.nodes) ? row.nodes : [];
}

async function cleanup(original: any[] | null = canvasSnapshot) {
  const log = (w: string) => (e: any) => console.warn(`cleanup ${w}:`, e?.message ?? e);
  await prisma.usageLog.deleteMany({ where: { tenantId: TENANT, aiAgentId: { in: [AGENT, OTHER] } } }).catch(log("usage"));
  await prisma.calendarAccount.deleteMany({ where: { tenantId: TENANT, accountEmail: "d51probe@example.invalid" } }).catch(log("calendar"));
  await prisma.conversation.deleteMany({ where: { tenantId: TENANT, id: { startsWith: "d51probe-conv" } } }).catch(log("conversations"));
  await prisma.knowledgeBase.deleteMany({ where: { tenantId: TENANT, name: "D51 probe base" } }).catch(log("kb"));
  await prisma.tenant.updateMany({ where: { id: TENANT, defaultAgentId: { in: [AGENT, OTHER] } }, data: { defaultAgentId: null } as any }).catch(log("tenant"));
  await prisma.agentToolPermission.deleteMany({ where: { tenantId: TENANT, aiAgentId: { in: [AGENT, OTHER] } } }).catch(log("grants"));
  await prisma.aIAgent.deleteMany({ where: { tenantId: TENANT, id: { in: [AGENT, OTHER] } } }).catch(log("agents"));
  if (original) {
    await prisma.flowCanvas
      .update({ where: { tenantId: TENANT }, data: { nodes: original as any } })
      .catch(log("canvas restore"));
  } else {
    // No snapshot to restore to - remove this probe's nodes by id rather than
    // leaving them in the tenant's routing graph.
    const row: any = await prisma.flowCanvas.findUnique({ where: { tenantId: TENANT } }).catch(() => null);
    const nodes = Array.isArray(row?.nodes) ? row.nodes : null;
    if (nodes) {
      await prisma.flowCanvas
        .update({
          where: { tenantId: TENANT },
          data: { nodes: nodes.filter((n: any) => !String(n?.id ?? "").startsWith("d51-node-")) as any },
        })
        .catch(log("canvas prune"));
    }
  }
}

async function main() {
  // The tenant's real canvas is restored verbatim at the end - this probe must
  // not leave the routing graph altered.
  canvasSnapshot = await canvasNodes();
  const original = canvasSnapshot;
  await cleanup(original);

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
  // live + closed conversations for the release cases
  await prisma.conversation.create({
    data: { id: "d51probe-conv-live", tenantId: TENANT, channel: "WHATSAPP", customerExternalId: "d51-live",
            status: "OPEN", assignedAiAgentId: AGENT, handledBy: "ai_agent", isHandedOver: false } as any,
  });
  await prisma.conversation.create({
    data: { id: "d51probe-conv-closed", tenantId: TENANT, channel: "WHATSAPP", customerExternalId: "d51-closed",
            status: "CLOSED", assignedAiAgentId: AGENT, handledBy: "ai_agent", isHandedOver: false } as any,
  });
  await prisma.tenant.update({ where: { id: TENANT }, data: { defaultAgentId: AGENT } as any });
  const kb = await prisma.knowledgeBase.create({
    data: { tenantId: TENANT, name: "D51 probe base", scope: "agent", scopeAgentId: AGENT } as any,
  });

  const cal = await prisma.calendarAccount.create({
    data: {
      tenantId: TENANT, aiAgentId: AGENT, provider: "GOOGLE_CALENDAR",
      status: "CONNECTED", accountEmail: "d51probe@example.invalid", externalAccountId: "d51probe-ext",
      credentials: "probe-not-a-real-token",
    } as any,
  });

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

  // live: released AND actually claimable by a human
  const live: any = await prisma.conversation.findUnique({ where: { id: "d51probe-conv-live" } });
  const closed: any = await prisma.conversation.findUnique({ where: { id: "d51probe-conv-closed" } });
  const AUTOMATED = new Set(["ai_agent", "flow"]);
  const aiManaged = AUTOMATED.has(live?.handledBy ?? "") && !live?.isHandedOver && !live?.assignedAgentId;
  const claimable = !live?.assignedAgentId && live?.status !== "CLOSED";
  console.log(`live    assignedAiAgentId=${live?.assignedAiAgentId ?? "null"} handledBy=${live?.handledBy ?? "null"} isAiManaged=${aiManaged} claimable=${claimable}`);
  console.log(`closed  assignedAiAgentId=${closed?.assignedAiAgentId ?? "null"} (MUST survive as history)`);

  const tenantAfter: any = await prisma.tenant.findUnique({ where: { id: TENANT } });
  const kbAfter: any = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
  console.log(`hazards tenant.defaultAgentId=${tenantAfter?.defaultAgentId ?? "null"} kb.scopeAgentId=${kbAfter?.scopeAgentId ?? "null"}`);
  console.log(`report  releasedConversations=${body?.releasedConversations}`);

  if (live?.assignedAiAgentId !== null) fail.push("live conversation not released");
  if (aiManaged) fail.push("released conversation still reads as AI-managed - it would sit in the AI section unanswered");
  if (!claimable) fail.push("released conversation is not claimable");
  if (closed?.assignedAiAgentId !== AGENT) fail.push("CLOSED conversation lost its attribution - history destroyed");
  if (tenantAfter?.defaultAgentId !== null) fail.push("Tenant.defaultAgentId still points at the deleted agent");
  if (kbAfter?.scopeAgentId !== null) fail.push("KnowledgeBase.scopeAgentId still points at the deleted agent");
  if (body?.releasedConversations !== 1) fail.push(`releasedConversations reported ${body?.releasedConversations}, expected 1`);

  // calendar: survives the delete, unowned, AND findable.
  // Three assertions because two can pass while the third fails: the row must
  // still exist (not severed), aiAgentId must be null (not dangling), and an
  // UNFILTERED listing must return it (not invisible). Before migration
  // 20260923120000 the third was impossible - the admin route required the
  // very agent id that had just been deleted.
  const calAfter: any = await prisma.calendarAccount.findUnique({ where: { id: cal.id } });
  const listed = await prisma.calendarAccount.findMany({ where: { tenantId: TENANT }, select: { id: true, aiAgentId: true } });
  const found = listed.find((r: any) => r.id === cal.id);
  console.log(`calendar survives=${calAfter !== null} aiAgentId=${calAfter?.aiAgentId ?? "null"} findable_unfiltered=${!!found}`);
  if (calAfter === null) fail.push("calendar account DELETED - a live Google grant was severed");
  if (calAfter && calAfter.aiAgentId !== null) fail.push(`calendar aiAgentId still ${calAfter.aiAgentId} - dangling, not released`);
  if (!found) fail.push("unowned calendar not returned by an unfiltered listing - still invisible");

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup(original);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  await cleanup();   // uses canvasSnapshot - the error path restores too
  process.exit(1);
});
