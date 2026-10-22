/**
 * Event-bus bridge for the notification engine.
 *
 * The shared package's lib/approval-requests.ts publishes `approval:created`
 * on the Redis pub/sub bus when an ApprovalRequest is written. We can't have
 * @chatcenter/shared depend on services/ai (would be circular), so the
 * notification engine subscribes here and re-fires as a SystemEvent. Same
 * pattern can be reused for any other inter-service notification trigger.
 *
 * Started from the AI service boot path next to the dispatcher worker.
 */

import { reportOperationalFailure, ERROR_CODES, prisma } from "@chatcenter/shared";
import { subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { tryEmit } from "./event-emitter.service";
import { notifyManagerOfApproval } from "./whatsapp-approval.service";

let _started = false;
let _sub: ReturnType<typeof subscribeToEvents> | null = null;

export function startNotificationEventBridge(): void {
  if (_started) return;
  _started = true;
  try {
    _sub = subscribeToEvents((evt: ServiceEvent) => {
      try {
        if (evt.event === "approval:approved" || evt.event === "approval:rejected" || evt.event === "approval:expired") {
          // Decided or expired: its notices are done, nothing is left to open.
          void resolveApprovalNotices(evt.tenantId, evt.data?.approvalId).catch((err: any) =>
            console.warn("[notifications.bridge] resolving approval notices failed:", err?.message),
          );
        }
        if (evt.event === "approval:created") {
          // A plan is said from its steps, for each reader, and never to the
          // person who proposed it (the event carries no params, so they are read here).
          const planned = planOf(evt.tenantId, evt.data?.id, evt.data?.tool);
          void planned.then((plan) => tryEmit({
            type: "tool.approval_required",
            tenantId: evt.tenantId,
            data: {
              approvalRequestId: evt.data?.id,
              tool: evt.data?.tool,
              summary: evt.data?.summary,
              riskLevel: evt.data?.riskLevel,
              requestedBy: evt.data?.requestedBy,
              expiresAt: evt.data?.expiresAt,
              ...(plan ? { plan } : {}),
            },
            metadata: {
              conversationId: evt.data?.conversationId ?? undefined,
            },
          }));

          // Out-of-band manager ping (opt-in per tenant). Fire-and-forget:
          // the approval already exists in the in-app inbox, so a WhatsApp
          // problem must never break the in-app notification above.
          void planned.then((plan) => notifyManagerOfApproval(evt.tenantId, evt.data ?? {}, plan)).catch((err: any) => {
            console.warn("[notifications.bridge] whatsapp approval notify failed:", err?.message);
            // The approval exists and the approver was never told. Distinct
            // from a customer completion notification: here the action is
            // stuck waiting on a human who does not know they are needed.
            reportOperationalFailure({
              errorCode: ERROR_CODES.hitl_notification_failed,
              domain: "hitl", service: "notifications", provider: "whatsapp",
              cause: err,
              context: { channel: "whatsapp", stage: "approver_notify" },
            });
          });
        }
      } catch (err: any) {
        console.warn("[notifications.bridge] handler failed:", err?.message);
      }
    });
    console.log("[notifications] event bridge started (approval:created, approved, rejected, expired)");
  } catch (err: any) {
    console.warn("[notifications.bridge] subscribe failed:", err?.message);
  }
}

/** A plan's steps, who asked and where, for the approval notice; null for anything else. */
export async function planOf(tenantId: string, approvalId: unknown, tool: unknown): Promise<Record<string, unknown> | null> {
  if (tool !== "propose_plan" || typeof approvalId !== "string" || !approvalId) return null;
  try {
    const row = await (prisma as any).approvalRequest.findFirst({ where: { id: approvalId, tenantId }, select: { params: true } });
    const p = (row?.params ?? {}) as Record<string, any>;
    return { steps: Array.isArray(p.steps) ? p.steps : [], requester: p.requester ?? null, source: typeof p.source === "string" ? p.source : null };
  } catch {
    return null;
  }
}

/**
 * A request that was approved, rejected or expired: its notices are marked
 * read, so the panel never offers to open something already decided.
 */
export async function resolveApprovalNotices(tenantId: string, approvalId: unknown): Promise<number> {
  if (typeof approvalId !== "string" || !approvalId) return 0;
  const r = await (prisma as any).inAppNotification.updateMany({
    where: { tenantId, targetType: "approval", targetId: approvalId, read: false },
    data: { read: true },
  });
  return r.count;
}

export async function stopNotificationEventBridge(): Promise<void> {
  if (_sub) {
    try { await _sub.quit(); } catch { /* ignore */ }
    _sub = null;
  }
  _started = false;
}
