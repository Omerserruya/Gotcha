/**
 * What counts toward the plan's automation limit (limit:workflows).
 *
 * Every automation and flow the workspace has, except the setup route: the
 * "who answers new conversations" automation onboarding writes is part of
 * being set up, not something the owner chose to build (Omer, 2026-11-02).
 */
import { prisma, SETUP_ORIGIN } from "@chatcenter/shared";

export async function workflowsTowardLimit(tenantId: string): Promise<number> {
  const [all, setup] = await Promise.all([
    prisma.chatbotFlow.count({ where: { tenantId } }),
    prisma.chatbotFlow.count({ where: { tenantId, triggerConfig: { path: ["origin"], equals: SETUP_ORIGIN } } as any }),
  ]);
  return all - setup;
}
