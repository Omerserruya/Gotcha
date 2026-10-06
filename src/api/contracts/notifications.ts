import { z } from 'zod';

/**
 * Notifications.
 *
 * Two things shape how this is written.
 *
 * **`eventType` is not an enum.** It is a plain string column written straight
 * through from whatever produced the event, and none of the types the product
 * brief names are actually emitted. So nothing branches on it: it is carried
 * for display and diagnostics only. `priority` IS a real enum and is what the
 * interface groups and sorts by.
 *
 * **`link` is free text.** There are no typed foreign keys - no
 * `conversationId`, no `approvalId`. Routing is a string somebody wrote, which
 * means it is untrusted input and goes through `safeInternalPath` before it
 * reaches an `href`.
 */
export const NOTIFICATION_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const notificationSchema = z.looseObject({
  id: z.string().min(1),
  eventType: z.string().optional(),
  priority: z.enum(NOTIFICATION_PRIORITIES).catch('MEDIUM'),
  title: z.string().optional(),
  body: z.string().optional(),
  link: z.string().nullable().optional(),
  read: z.boolean().default(false),
  createdAt: z.string().optional(),
});

/** Cursor-paginated - the cleanest convention the platform has. */
export const notificationPageSchema = z.looseObject({
  data: z.array(notificationSchema).default([]),
  nextCursor: z.string().nullable().optional(),
});

/** `GET /api/notifications/unread-count` answers bare. */
export const unreadCountSchema = z.looseObject({ count: z.number().default(0) });

export type Notification = z.infer<typeof notificationSchema>;

// ── Settings · Notifications - screen 15 ────────────────────────────

/**
 * `GET`/`PATCH /api/notification-preferences/me` - enveloped in `data`.
 *
 * **This is not the design's matrix, and the difference is a product
 * decision rather than a scope adjustment.**
 *
 * The design draws 8 event rows × 3 channels = 24 switches. Per user the
 * platform stores **four booleans and a time window**. `approvals` is the only
 * event-specific field that exists - one of the eight rows.
 *
 * A real matrix does exist and is richer than the design asks (`eventType` ×
 * `channels[]`, with recipients, CEL-lite conditions and priority) - but it is
 * scoped `(tenantId, departmentId)` and phrased as *"when X happens, notify
 * these people"*. The screen says *"tell me when"*. Those are different
 * products: one is my preference, the other is the tenant's routing rule.
 *
 * Two further things the design draws that cannot be stored:
 *   - **the quiet-hours exception** (*"unless an action failed with money
 *     involved"*). There is no exception mechanism of any kind.
 *   - **a day-of-week** (*"and all day Saturday"*). The window is two strings.
 *
 * So the screen shows the window it can actually keep, and no carve-out.
 */
export const quietHoursSchema = z.object({
  /** "HH:MM", 24-hour. The backend rejects anything else rather than coercing. */
  from: z.string(),
  to: z.string(),
});

export const notificationPreferencesSchema = z.object({
  inApp: z.boolean().default(true),
  email: z.boolean().default(true),
  whatsapp: z.boolean().default(false),
  /** The one event-specific preference the platform has. */
  approvals: z.boolean().default(true),
  /**
   * One nullable object rather than two fields, because a window needs both
   * ends to mean anything - the backend clears them together for that reason.
   */
  quietHours: quietHoursSchema.nullable().default(null),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
