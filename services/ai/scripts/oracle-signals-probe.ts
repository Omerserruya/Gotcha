/**
 * P1-1 live probe - assemble REAL Oracle facts for one agent and print the
 * three signals that used to be stubbed: billing.status, permissions
 * (grant-derived allow-list), and the committed goal.
 *
 * Run inside the ai container:
 *   docker compose exec ai npx tsx scripts/oracle-signals-probe.ts <tenantId> <aiAgentId> <conversationId>
 */

import { prisma } from "@chatcenter/shared";
import { assembleOracleFacts } from "../src/services/agent-loop/oracle-assembler";
import { loadToolGrants, deriveAllowedOperations } from "../src/services/agent-loop/permissions-bridge";
import { loadCommittedGoal } from "../src/services/plan-context.service";

const [tenantId, aiAgentId, conversationId] = process.argv.slice(2);
if (!tenantId || !aiAgentId) {
  console.error("usage: oracle-signals-probe.ts <tenantId> <aiAgentId> [conversationId]");
  process.exit(1);
}

(async () => {
  const grants = await loadToolGrants(tenantId, aiAgentId);
  console.log("[probe] grants:", { governed: grants.governed, allowedToolSlugs: [...grants.allowedToolSlugs] });

  const facts = await assembleOracleFacts({
    ctx: { tenantId, aiAgentId, conversationId: conversationId ?? "probe", customerExternalId: "probe", customerEmail: undefined },
    base: { customer: { knownFields: {}, identityResolved: false }, permissions: { allowedOperations: [] } },
    grants,
    now: new Date().toISOString(),
  });
  console.log("[probe] billing:", facts.billing, "entitlements:", facts.entitlements);
  console.log("[probe] permissions.allowedOperations:", facts.permissions.allowedOperations);
  console.log("[probe] menu:", facts.availableOperations.map((o) => o.name));

  if (conversationId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { channel: true, customerExternalId: true },
    });
    const goal = await loadCommittedGoal(tenantId, conversationId, {
      channel: String(conv?.channel ?? ""),
      externalId: conv?.customerExternalId,
    });
    console.log("[probe] committedGoal:", goal);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("[probe] error:", e); process.exit(1); });
