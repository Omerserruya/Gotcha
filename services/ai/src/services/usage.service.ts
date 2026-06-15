/**
 * Centralized Usage Tracking Service
 *
 * Tracks ALL platform usage:
 * - AI token consumption
 * - Messages sent
 * - Tool executions
 * - Automation runs
 *
 * Converts usage → tokens → credits and persists to:
 * - usage_logs (raw events)
 * - credit_transactions (credit impact)
 *
 * NO enforcement - tracking only for future billing.
 */

import { prisma } from "@chatcenter/shared";

// ─── Types ──────────────────────────────────────────────────

export type UsageType = "ai_tokens" | "message_sent" | "tool_call" | "automation_run";

export interface UsageEvent {
  tenantId: string;
  type: UsageType;
  quantity: number;
  metadata?: {
    model?: string;
    channel?: string;
    tool?: string;
    conversationId?: string;
    messageId?: string;
    [key: string]: any;
  };
}

// ─── Core: Track Usage ──────────────────────────────────────
// Usage tracking is straightforward: quantity = actual value returned by the provider.
// For ai_tokens, quantity is the actual token count from the model response.
// For message_sent, quantity is the number of messages (1).
// For tool_call, quantity is the number of executions (1).
// No artificial flat rates or credit conversions - raw data only.

export async function trackUsage(event: UsageEvent): Promise<void> {
  try {

    // Write usage log with actual quantity from the provider
    await prisma.usageLog.create({
      data: {
        tenantId: event.tenantId,
        type: event.type,
        quantity: event.quantity,
        tokensEquivalent: event.quantity, // actual tokens - no artificial conversion
        metadata: event.metadata || undefined,
      },
    });

    // Note: NO enforcement - we only track, never block
  } catch (err: any) {
    // Never throw - usage tracking should never break business logic
    console.error("[usageService] Failed to track usage:", err.message);
  }
}

// ─── Convenience: Track AI Tokens ───────────────────────────

export async function trackAITokens(
  tenantId: string,
  totalTokens: number,
  metadata?: { model?: string; conversationId?: string; type?: string },
): Promise<void> {
  return trackUsage({
    tenantId,
    type: "ai_tokens",
    quantity: totalTokens,
    metadata,
  });
}

// ─── Convenience: Track Message Sent ────────────────────────

export async function trackMessageSent(
  tenantId: string,
  metadata?: { channel?: string; conversationId?: string; messageId?: string },
): Promise<void> {
  return trackUsage({
    tenantId,
    type: "message_sent",
    quantity: 1,
    metadata,
  });
}

// ─── Convenience: Track Tool Call ───────────────────────────

export async function trackToolCall(
  tenantId: string,
  metadata?: { tool?: string; conversationId?: string },
): Promise<void> {
  return trackUsage({
    tenantId,
    type: "tool_call",
    quantity: 1,
    metadata,
  });
}

// ─── Convenience: Track Automation Run ──────────────────────

export async function trackAutomationRun(
  tenantId: string,
  metadata?: { conversationId?: string; [key: string]: any },
): Promise<void> {
  return trackUsage({
    tenantId,
    type: "automation_run",
    quantity: 1,
    metadata,
  });
}
