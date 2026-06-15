/**
 * Full Audit Logging Service
 *
 * Logs ALL system events for:
 * - Debugging
 * - Security tracing
 * - Customer support investigation
 * - Future compliance (SOC2 mindset)
 *
 * Actors: user, ai, system
 * NOT the same as usage tracking - this is about WHO did WHAT.
 */

import { prisma } from "@chatcenter/shared";

// ─── Types ──────────────────────────────────────────────────

export type ActorType = "user" | "ai" | "system";

export interface AuditEvent {
  tenantId: string;
  actor: {
    type: ActorType;
    id?: string;
  };
  action: string;
  target?: {
    type: string;
    id: string;
  };
  metadata?: Record<string, any>;
  timestamp?: Date;
}

// ─── Core: Log Audit Event ──────────────────────────────────

export async function logAudit(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actorType: event.actor.type,
        actorId: event.actor.id || null,
        action: event.action,
        targetType: event.target?.type || null,
        targetId: event.target?.id || null,
        metadata: event.metadata || undefined,
        createdAt: event.timestamp || new Date(),
      },
    });
  } catch (err: any) {
    // Never throw - audit logging should never break business logic
    console.error("[auditService] Failed to log audit event:", err.message);
  }
}

// ─── Convenience Helpers ────────────────────────────────────

export async function logUserAction(
  tenantId: string,
  userId: string,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, any>,
): Promise<void> {
  return logAudit({
    tenantId,
    actor: { type: "user", id: userId },
    action,
    target,
    metadata,
  });
}

export async function logAIAction(
  tenantId: string,
  aiAgentId: string | undefined,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, any>,
): Promise<void> {
  return logAudit({
    tenantId,
    actor: { type: "ai", id: aiAgentId },
    action,
    target,
    metadata,
  });
}

export async function logSystemAction(
  tenantId: string,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, any>,
): Promise<void> {
  return logAudit({
    tenantId,
    actor: { type: "system" },
    action,
    target,
    metadata,
  });
}
