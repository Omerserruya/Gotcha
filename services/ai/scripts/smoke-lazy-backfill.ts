/**
 * Smoke test: lazy-backfill of sharedPrompt / autonomousPrompt for an
 * AIAgent that pre-dates the prompt-parts column.
 *
 * What this verifies:
 *   1. Pick an AI agent (Rotem if present, else the most recently created
 *      one with sharedPrompt = NULL).
 *   2. Show its current state.
 *   3. NULL out sharedPrompt + autonomousPrompt (simulate a stale row).
 *   4. Call buildAgentSystemPrompt(agent) — same code path the production
 *      autonomous bot runs.
 *   5. Re-fetch the row. Both columns must now be populated and the
 *      returned prompt must be a non-empty string containing the expected
 *      sections from assemblePrompt.
 *
 * Reads DATABASE_URL from env. To target the local docker-compose db
 * exposed on the host:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_cc tsx scripts/smoke-lazy-backfill.ts
 */

import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { buildAgentSystemPrompt } from "../src/services/ai-bot.service";

const TARGET_NAME = process.env.SMOKE_AGENT_NAME || "Rotem";

async function main() {
  console.log(`[smoke] DATABASE_URL=${process.env.DATABASE_URL?.replace(/:[^:@/]+@/, ":***@")}`);

  // 1. Pick an agent (cross-tenant — this is an ops smoke script).
  // Lambdas MUST be async + await internally so Prisma's promise
  // resolution stays inside AsyncLocalStorage's scope.
  let agent = await withCrossTenantAccess(async () =>
    await prisma.aIAgent.findFirst({
      where: { name: { contains: TARGET_NAME, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (!agent) {
    console.log(`[smoke] No agent with name like "${TARGET_NAME}" — falling back to most recent agent.`);
    agent = await withCrossTenantAccess(async () =>
      await prisma.aIAgent.findFirst({ orderBy: { createdAt: "desc" } }),
    );
  }
  if (!agent) {
    console.error("[smoke] No AI agents in DB. Aborting.");
    process.exit(1);
  }

  const agentId = agent.id;
  const tenantId = agent.tenantId;
  console.log(`[smoke] Picked agent: ${agentId} (${agent.name}) — tenant ${tenantId}`);
  console.log(`[smoke] Before: sharedPrompt=${!!agent.sharedPrompt}, autonomousPrompt=${!!agent.autonomousPrompt}`);

  // 2. Force the lazy-backfill code path: blank both fields (tenant-scoped update is fine)
  await prisma.aIAgent.update({
    where: { id: agentId, tenantId },
    data: { sharedPrompt: null, autonomousPrompt: null },
  });
  console.log(`[smoke] Forced sharedPrompt=NULL, autonomousPrompt=NULL.`);

  // 3. Run production code path
  const start = Date.now();
  let systemPrompt: string;
  try {
    const reread = await prisma.aIAgent.findFirstOrThrow({ where: { id: agentId, tenantId } });
    systemPrompt = await buildAgentSystemPrompt(reread);
  } catch (err: any) {
    console.error("[smoke] FAILED:", err?.message);
    console.error(err?.stack);
    process.exit(2);
  }
  const elapsedMs = Date.now() - start;

  // 4. Verify
  const after = await prisma.aIAgent.findFirstOrThrow({ where: { id: agentId, tenantId } });
  const okShared = !!after.sharedPrompt && after.sharedPrompt.length > 0;
  const okAuto = !!after.autonomousPrompt && after.autonomousPrompt.length > 0;
  const okPrompt = systemPrompt.length > 100;
  const hasOverview = systemPrompt.includes("## Overview");
  const hasGuardrails = systemPrompt.toLowerCase().includes("guardrail") || systemPrompt.toLowerCase().includes("rules");

  console.log(`[smoke] Backfill latency: ${elapsedMs}ms`);
  console.log(`[smoke] After: sharedPrompt=${okShared} (${after.sharedPrompt?.length}b), autonomousPrompt=${okAuto} (${after.autonomousPrompt?.length}b)`);
  console.log(`[smoke] Returned prompt: ${systemPrompt.length}b, hasOverview=${hasOverview}, hasGuardrails=${hasGuardrails}`);
  console.log(`[smoke] First 300 chars:\n${systemPrompt.slice(0, 300)}`);
  console.log(`[smoke] Last 300 chars:\n${systemPrompt.slice(-300)}`);

  const allOk = okShared && okAuto && okPrompt && hasOverview;
  if (!allOk) {
    console.error(`[smoke] FAIL — okShared=${okShared} okAuto=${okAuto} okPrompt=${okPrompt} hasOverview=${hasOverview}`);
    process.exit(3);
  }
  console.log(`[smoke] PASS ✓`);

  // 5. Second run: should be a no-op (no extra DB writes for backfill).
  const start2 = Date.now();
  const sp2 = await buildAgentSystemPrompt(after);
  const elapsedMs2 = Date.now() - start2;
  console.log(`[smoke] Second run (already populated): ${elapsedMs2}ms, prompt matches: ${sp2 === systemPrompt}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
