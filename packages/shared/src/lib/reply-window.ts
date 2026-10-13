import { prisma } from "./prisma";

/**
 * The customer-service window (B7, 2026-10-12): when a business may write to
 * a customer, and how.
 *
 * - WhatsApp: free text for 24 hours after the customer's last message; past
 *   it only an approved template may be sent (it is what reopens the window).
 * - Instagram and Messenger: free text for 24 hours; past it nothing may be
 *   sent at all.
 * - Email and every other channel: no window.
 *
 * Meta enforces it anyway (WhatsApp error 131047, "Re-engagement message"), so
 * this rule exists to refuse BEFORE the send: nine free-text sends into a
 * closed window, each failing the same way, is what happened without it.
 *
 * "The customer's last message" is LIVE, INBOUND and not a system row (the
 * unread rule), for this customer on this channel and channel account, across
 * all of their conversations there: the window belongs to the customer and the
 * business number, not to one conversation.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReplyWindowMode = "free" | "template_only" | "closed";

export interface ReplyWindow {
  channel: string;
  /** Free text may be sent now. */
  open: boolean;
  /** When free text stops being allowed; null when the window is closed or there is none. */
  closesAt: string | null;
  mode: ReplyWindowMode;
}

/** What each windowed channel allows once the window has closed. */
const AFTER_WINDOW: Record<string, Exclude<ReplyWindowMode, "free">> = {
  WHATSAPP: "template_only",
  INSTAGRAM: "closed",
  MESSENGER: "closed",
};

export function hasReplyWindow(channel: string | null | undefined): boolean {
  return !!channel && channel in AFTER_WINDOW;
}

export function replyWindowFor(channel: string, lastInboundAt: Date | null, now: Date = new Date()): ReplyWindow {
  if (!hasReplyWindow(channel)) return { channel, open: true, closesAt: null, mode: "free" };
  if (lastInboundAt) {
    const closes = lastInboundAt.getTime() + REPLY_WINDOW_MS;
    if (now.getTime() < closes) return { channel, open: true, closesAt: new Date(closes).toISOString(), mode: "free" };
  }
  return { channel, open: false, closesAt: null, mode: AFTER_WINDOW[channel]! };
}

export type ReplyWindowRefusal = "TEMPLATE_REQUIRED" | "REPLY_WINDOW_CLOSED";

/** May a message of this type be sent through this window? */
export function sendAllowed(
  window: ReplyWindow,
  messageType: string | null | undefined,
): { ok: true } | { ok: false; code: ReplyWindowRefusal; message: string } {
  if (window.mode === "free") return { ok: true };
  if (window.mode === "template_only") {
    if (messageType === "template") return { ok: true };
    return {
      ok: false,
      code: "TEMPLATE_REQUIRED",
      message: "More than 24 hours since the customer last wrote: WhatsApp allows only an approved template until they reply.",
    };
  }
  return {
    ok: false,
    code: "REPLY_WINDOW_CLOSED",
    message: `More than 24 hours since the customer last wrote: ${window.channel === "INSTAGRAM" ? "Instagram" : "Messenger"} allows no further message until they write again.`,
  };
}

type Db = { $queryRaw: typeof prisma.$queryRaw };

/** The customer's last message, for one recipient (the outgoing worker: it has no page, and a broadcast has no conversation). */
export async function lastInboundAtForRecipient(
  args: { tenantId: string; channel: string; channelAccountId: string | null; customerExternalId: string },
  db: Db = prisma,
): Promise<Date | null> {
  const rows = await db.$queryRaw<Array<{ last: Date | null }>>`
    SELECT max(m.created_at) AS last
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = ${args.tenantId}
     WHERE m.tenant_id = ${args.tenantId}
       AND c.channel::text = ${args.channel}
       AND c.customer_external_id = ${args.customerExternalId}
       AND (${args.channelAccountId}::text IS NULL OR c.channel_account_id IS NULL OR c.channel_account_id = ${args.channelAccountId})
       AND m.direction = 'INBOUND'
       AND m.message_type <> 'system'
       AND m.origin = 'LIVE'`;
  const last = rows[0]?.last;
  return last ? new Date(last) : null;
}

/** The window for each conversation of a page: one query, no N+1. */
export async function replyWindowsFor(
  tenantId: string,
  conversationIds: string[],
  db: Db = prisma,
  now: Date = new Date(),
): Promise<Map<string, ReplyWindow>> {
  const out = new Map<string, ReplyWindow>();
  if (conversationIds.length === 0) return out;
  const rows = await db.$queryRaw<Array<{ id: string; channel: string; last: Date | null }>>`
    SELECT c.id, c.channel::text AS channel,
           (SELECT max(m.created_at)
              FROM messages m
              JOIN conversations c2 ON c2.id = m.conversation_id AND c2.tenant_id = ${tenantId}
             WHERE m.tenant_id = ${tenantId}
               AND c2.channel = c.channel
               AND c2.customer_external_id = c.customer_external_id
               AND (c.channel_account_id IS NULL OR c2.channel_account_id IS NULL OR c2.channel_account_id = c.channel_account_id)
               AND m.direction = 'INBOUND'
               AND m.message_type <> 'system'
               AND m.origin = 'LIVE') AS last
      FROM conversations c
     WHERE c.tenant_id = ${tenantId}
       AND c.id = ANY(${conversationIds}::text[])`;
  for (const r of rows) out.set(r.id, replyWindowFor(r.channel, r.last ? new Date(r.last) : null, now));
  return out;
}
