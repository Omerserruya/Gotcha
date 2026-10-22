/**
 * The typed category a notification is rendered by, DERIVED from the event that
 * produced it.
 *
 * WHY DERIVED AND NOT STORED
 * The interface branches on a small enum; the producers emit twenty-five
 * specific event types. Rewriting `eventType` into the enum on the way in would
 * make the row unable to answer what actually happened - three different
 * failures all become ACTION_FAILED and the difference is gone from the
 * database, not just from the screen. Deriving costs nothing, keeps the
 * specific event, and means a mapping change re-classifies HISTORY rather than
 * only what arrives next.
 *
 * COVERAGE, HONESTLY
 * Four of the twenty-five event types map onto the interface's five real
 * categories. The rest - the whole billing, subscription, invoice and AI-credit
 * family - have no counterpart, and three of the declared categories have no
 * producer at all. OTHER exists so those notifications still REACH the bell:
 * the alternative is either dropping them, or filing an invoice under a
 * heading that has nothing to do with invoices. An untyped notification is
 * visibly unclassified; a wrongly typed one is not, and the reader has no way
 * to tell.
 */

export const NOTIFICATION_CATEGORIES = [
  "APPROVAL_REQUIRED",
  "ACTION_FAILED",
  "INTEGRATION_DISCONNECTED",
  "AI_PAUSED",
  "CAMPAIGN_COMPLETED",
  "COMPLAINT_SPIKE",
  /** Reached the bell, has no category yet. Never a synonym for "unimportant". */
  "OTHER",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationTargetType =
  | "conversation" | "approval" | "integration" | "campaign" | "none";

/**
 * Event type to category.
 *
 * Only mappings that are TRUE are here. INTEGRATION_DISCONNECTED, AI_PAUSED and
 * COMPLAINT_SPIKE are declared in the domain and absent from this table because
 * nothing emits them yet - the frontend can be built against the whole set, and
 * the day an emitter exists it gets one line here and no other change.
 */
const EVENT_CATEGORY: Record<string, NotificationCategory> = {
  "tool.approval_required": "APPROVAL_REQUIRED",
  "payment.failed": "ACTION_FAILED",
  "system.error.critical": "ACTION_FAILED",
  "credit.auto_purchase_failed": "ACTION_FAILED",
};

export function notificationCategory(eventType: string | null | undefined): NotificationCategory {
  const raw = (eventType ?? "").trim();
  if (!raw) return "OTHER";
  // A row already holding a category passes through, so the historical rows an
  // earlier backfill rewrote still classify as themselves.
  const upper = raw.toUpperCase();
  if ((NOTIFICATION_CATEGORIES as readonly string[]).includes(upper)) {
    return upper as NotificationCategory;
  }
  return EVENT_CATEGORY[raw] ?? "OTHER";
}

/**
 * Where a notification points, from the event and its metadata.
 *
 * Derived at WRITE time rather than read time, unlike the category: the
 * metadata that names the target is present when the event fires and is not
 * kept on the row afterwards. A link string cannot stand in for it - it cannot
 * be validated, and the interface cannot tell from it which affordance to
 * render.
 */
export function notificationTarget(
  eventType: string | null | undefined,
  meta: Record<string, unknown> | null | undefined,
): { targetType: NotificationTargetType; targetId: string | null } {
  const m = meta ?? {};
  const pick = (k: string): string | null => {
    const v = m[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  if (notificationCategory(eventType) === "APPROVAL_REQUIRED") {
    const id = pick("approvalRequestId") ?? pick("approvalId");
    if (id) return { targetType: "approval", targetId: id };
  }

  const campaignId = pick("broadcastId") ?? pick("campaignId");
  if (campaignId) return { targetType: "campaign", targetId: campaignId };

  const integrationId = pick("integrationId") ?? pick("connectionId");
  if (integrationId) return { targetType: "integration", targetId: integrationId };

  const conversationId = pick("conversationId");
  if (conversationId) return { targetType: "conversation", targetId: conversationId };

  // Explicitly "none" rather than null: a notification with nothing to open is
  // a decision the interface should render as such, not an absent value it has
  // to guess about.
  return { targetType: "none", targetId: null };
}
