/**
 * The contract for the outbound email queue, shared by the service that fills
 * it and the service that drains it.
 *
 * It lives here because billing now sends the receipt. Notifications still owns
 * delivery - the SMTP transport, the retries, the log - but it is no longer the
 * only service with something to say, and a queue whose name and payload shape
 * are declared inside the consumer is a queue the producer has to guess at.
 *
 * Note what does NOT come through here: the notification engine's fan-out,
 * which resolves recipients from tenant users and honours their preferences.
 * That is right for a nudge and wrong for a receipt, which goes to the billing
 * address whether or not that address belongs to a user, and which nobody is
 * allowed to opt out of.
 */
export const NOTIFICATIONS_EMAIL_QUEUE_NAME = "notifications-email";

export interface EmailJobData {
  tenantId: string;
  /** Empty for a recipient who is not a platform user, e.g. a billing address. */
  userId: string;
  to: string;
  eventType: string;
  eventId: string;
  priority: string;
  subject: string;
  /** Plain-text body. Always set: it is the text/plain part of the message. */
  body: string;
  link?: string;
  /**
   * Pre-rendered HTML. When present the worker sends it as-is instead of
   * wrapping `body` in its own markup - the only way a designed email survives
   * the pipe.
   */
  html?: string;
  /**
   * Skip the per-user send rate limit. For mail that is a legal record rather
   * than a notification, where dropping one is worse than sending one too many.
   */
  bypassRateLimit?: boolean;
}
