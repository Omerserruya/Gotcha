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
 * **`link` is free text.** There are no typed foreign keys — no
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

/** Cursor-paginated — the cleanest convention the platform has. */
export const notificationPageSchema = z.looseObject({
  data: z.array(notificationSchema).default([]),
  nextCursor: z.string().nullable().optional(),
});

/** `GET /api/notifications/unread-count` answers bare. */
export const unreadCountSchema = z.looseObject({ count: z.number().default(0) });

export type Notification = z.infer<typeof notificationSchema>;
