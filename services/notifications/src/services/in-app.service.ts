/**
 * In-app notification service.
 *
 * Persists a row in `in_app_notifications` and pushes a real-time
 * announcement onto the existing shared Redis pub/sub event bus
 * (`@chatcenter/shared` -> `publishEvent`). The dashboard's WebSocket
 * gateway subscribes to that bus; if a user has no active connection
 * the row stays visible via the GET /notifications polling endpoint.
 *
 * Design note: this codebase has NO dedicated /ws gateway in services/ai -
 * realtime delivery is via the shared Redis pub/sub bus consumed by the
 * dashboard's nginx-proxied SSE/WS server. The publishEvent envelope is
 * the same one used by approval-requests for the inbox banner, so the
 * bell-badge / notification-list components subscribe with zero new
 * plumbing.
 */

import { prisma, publishEvent, notificationTarget, notificationCategory } from "@chatcenter/shared";
import type { SystemEventType } from "./event-emitter.service";

export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface CreateInAppNotificationInput {
  tenantId: string;
  userId: string;
  eventType: SystemEventType | string;
  title: string;
  body: string;
  link?: string;
  priority?: Priority;
  /**
   * The event's metadata, used to resolve the typed target.
   *
   * Resolved at WRITE time because this is when it exists: the ids that name
   * what a notification points at are on the event, and are not kept on the row.
   */
  metadata?: Record<string, unknown> | null;
}

export interface InAppNotificationRow {
  id: string;
  tenantId: string;
  userId: string;
  eventType: string;
  priority: string;
  title: string;
  body: string;
  link: string | null;
  targetType: string | null;
  targetId: string | null;
  read: boolean;
  createdAt: Date;
}

export async function createInAppNotification(
  input: CreateInAppNotificationInput,
): Promise<InAppNotificationRow> {
  const { targetType, targetId } = notificationTarget(input.eventType, input.metadata);

  const row: InAppNotificationRow = await (prisma as any).inAppNotification.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      eventType: input.eventType,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      // A typed target beside the free-text link, not instead of it: existing
      // clients keep reading `link`, and the interface gets something it can
      // branch on without parsing a path.
      targetType,
      targetId,
      priority: input.priority ?? "MEDIUM",
    },
  });

  // Real-time fan-out: emit on the shared Redis bus so the dashboard's
  // SSE/WS gateway can deliver to whichever browser session(s) the user
  // has open. Failure is non-fatal - the GET /notifications endpoint
  // always backstops with polling.
  publishEvent({
    event: "notification:created",
    tenantId: input.tenantId,
    data: {
      id: row.id,
      userId: row.userId,
      eventType: row.eventType,
      // The bell branches on the derived category; the raw event stays so the
      // row can still answer what actually happened.
      category: notificationCategory(row.eventType),
      targetType: row.targetType,
      targetId: row.targetId,
      priority: row.priority,
      title: row.title,
      body: row.body,
      link: row.link,
      createdAt: row.createdAt,
    },
  }).catch((err: any) => console.warn("[notifications.inApp] publishEvent failed:", err?.message));

  return row;
}
