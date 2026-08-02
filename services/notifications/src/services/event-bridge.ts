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
        if (evt.event === "approval:created") {
          tryEmit({
            type: "tool.approval_required",
            tenantId: evt.tenantId,
            data: {
              approvalRequestId: evt.data?.id,
              tool: evt.data?.tool,
              summary: evt.data?.summary,
              riskLevel: evt.data?.riskLevel,
              requestedBy: evt.data?.requestedBy,
              expiresAt: evt.data?.expiresAt,
            },
            metadata: {
              conversationId: evt.data?.conversationId ?? undefined,
            },
          });

          // Out-of-band manager ping (opt-in per tenant). Fire-and-forget:
          // the approval already exists in the in-app inbox, so a WhatsApp
          // problem must never break the in-app notification above.
          void notifyManagerOfApproval(evt.tenantId, evt.data ?? {}).catch((err: any) =>
            console.warn("[notifications.bridge] whatsapp approval notify failed:", err?.message),
          );
        }
      } catch (err: any) {
        console.warn("[notifications.bridge] handler failed:", err?.message);
      }
    });
    console.log("[notifications] event bridge started (subscribed to approval:created)");
  } catch (err: any) {
    console.warn("[notifications.bridge] subscribe failed:", err?.message);
  }
}

export async function stopNotificationEventBridge(): Promise<void> {
  if (_sub) {
    try { await _sub.quit(); } catch { /* ignore */ }
    _sub = null;
  }
  _started = false;
}
