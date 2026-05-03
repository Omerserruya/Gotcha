/**
 * Approval request helpers for the bot-surface F4 flow.
 *
 * Used from the bot engine when evaluateToolGate() returns
 * REQUIRE_APPROVAL. The bot pauses the conversation, creates a rich
 * request, and surfaces it in-inbox to a human agent via a banner in
 * the conversation view.
 *
 * See memory/bug_f4_approval_wrong_surface.md for the design.
 */
import { prisma } from "./prisma";
import { publishEvent } from "./event-bus";
import type { ToolGateResult } from "./tool-gate";

export interface CreateApprovalRequestInput {
  tenantId: string;
  /** Optional: System Copilot plans aren't always conversation-scoped
   * (e.g. "build a workflow"). Customer-facing approvals always set this. */
  conversationId?: string;
  contactId?: string;
  messageId?: string;
  tool: string;
  params: Record<string, unknown>;
  summary: string;      // one-sentence natural language for the card
  reason: string;       // bot's own reasoning for the card
  riskLevel?: "low" | "medium" | "high";
  riskTags?: string[];
  requestedBy: string;  // "bot" | "flow:<id>" | "ai-agent:<id>"
  gate?: ToolGateResult;
}

export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAfterMin = input.gate?.approvalConfig?.expiresAfterMin ?? 30;
  const expiresAt = new Date(Date.now() + expiresAfterMin * 60 * 1000);

  const created = await (prisma as any).approvalRequest.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId ?? null,
      contactId: input.contactId ?? null,
      messageId: input.messageId ?? null,
      tool: input.tool,
      params: input.params as any,
      summary: input.summary,
      reason: input.reason,
      policyRuleId: null,
      policyRuleName: input.gate?.reason ?? null,
      riskLevel: input.riskLevel ?? "medium",
      riskTags: (input.riskTags ?? []) as any,
      status: "PENDING",
      requestedBy: input.requestedBy,
      expiresAt,
    },
    select: { id: true, expiresAt: true, conversationId: true, tool: true, summary: true, riskLevel: true, requestedBy: true, createdAt: true },
  });
  // Surface as a tenant-scoped socket event so the Approvals page (and any
  // open inbox view) can render live without polling.
  await publishEvent({
    event: "approval:created",
    tenantId: input.tenantId,
    data: {
      id: created.id,
      conversationId: created.conversationId,
      tool: created.tool,
      summary: created.summary,
      riskLevel: created.riskLevel,
      requestedBy: created.requestedBy,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    },
  }).catch(() => {});
  return { id: created.id, expiresAt: created.expiresAt };
}

export async function findPendingByConversation(
  tenantId: string,
  conversationId: string,
) {
  return (prisma as any).approvalRequest.findMany({
    where: { tenantId, conversationId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
}

export async function approveRequest(
  tenantId: string,
  id: string,
  decidedBy: string,
  modifiedParams?: Record<string, unknown>,
  decisionReason?: string,
) {
  return (prisma as any).approvalRequest.update({
    where: { id },
    data: {
      status: "APPROVED",
      decidedBy,
      decidedAt: new Date(),
      decisionReason: decisionReason ?? null,
      modifiedParams: modifiedParams ?? null,
    },
  });
}

export async function rejectRequest(
  tenantId: string,
  id: string,
  decidedBy: string,
  decisionReason: string,
) {
  return (prisma as any).approvalRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      decidedBy,
      decidedAt: new Date(),
      decisionReason,
    },
  });
}
