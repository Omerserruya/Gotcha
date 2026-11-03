/**
 * "message.inbound": every customer message in a conversation people handle
 * reaches a phone - the assignee's, else the team's (mobile push, 2026-11-03).
 *
 * In shared because customer messages are persisted in two services: the
 * incoming worker (every channel's webhook path, the website widget and the
 * Shopify chat included) and services/ai, for the few customer messages its
 * public chat routes write themselves (the website's "continue on WhatsApp"
 * text, the Shopify offline form). One rule for both, so they cannot drift.
 *
 * A queue publish onto the notifications service's "notifications" queue
 * (the same job shape as its own emitEvent), never an LLM call. Its own lazy
 * Queue rather than lib/queue's notificationsQueue, so importing this opens
 * no Redis connection until something is actually sent. Fire-and-forget:
 * never awaited by a chat request, never throws into one.
 */
import { randomUUID } from "crypto";
import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let q: Queue | null = null;


/** A media message with no words of its own: the channel stores "[Image]" and the like. */
const PLACEHOLDER = /^\[[^\]]{1,40}\]$/;
const PREVIEW_MAX = 100;

/** The preview a push shows: the first ~100 chars, or the media kind for the template to name. */
export function inboundPreview(body: string | null | undefined, messageType: string | null | undefined): { preview: string; previewKind: "text" | "media" } {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  const isMedia = !!messageType && messageType !== "text";
  if (isMedia && (!text || PLACEHOLDER.test(text))) return { preview: text || `[${messageType}]`, previewKind: "media" };
  const cut = text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}\u2026` : text;
  return { preview: cut, previewKind: "text" };
}

export interface InboundConversation {
  id: string;
  assignedAgentId?: string | null;
  handledBy?: string | null;
  /** Handed to the team: no assignee yet, but people (not the bot) answer it. */
  isHandedOver?: boolean | null;
  customerName?: string | null;
  departmentId?: string | null;
  /** The product's definition of real traffic (lib/real-conversation.ts): optional, checked when present. */
  isTest?: boolean | null;
  customerExternalId?: string | null;
  origin?: string | null;
}

/**
 * Whether this inbound message is announced to someone's phone:
 *   - a person is assigned: to them (the notifications service sends it to
 *     the assignee only);
 *   - nobody is assigned but the conversation is with the TEAM (handed over,
 *     or handled by a human - someone replied from the queue without claiming
 *     it, 2026-11-03): to the people an escalation of it would reach;
 *   - the bot or a flow driving it with nobody on it: never.
 *
 * ⚠ A person on it wins over `handledBy`. Claiming a conversation sets the
 *   assignee and the handover latch but leaves `handledBy` as it was, so a
 *   conversation a person had just taken still read "ai_agent" - and every
 *   customer message in it went unannounced, to a phone that was waiting for
 *   it (dev, 2026-11-03). The bot's own rule (incoming.worker: it answers only
 *   with no assignee and no handover) and the inbox's "automated" rule
 *   (conversation.service listWhere) already read it this way.
 * And only real traffic - not a sandbox rehearsal, a test conversation or
 * imported history.
 */
export function shouldEmitInbound(conversation: Omit<InboundConversation, "id">): boolean {
  if (conversation.handledBy === "sandbox") return false;
  const withPeople = !!conversation.assignedAgentId || !!conversation.isHandedOver || conversation.handledBy === "human";
  if (!withPeople) return false;
  if (conversation.isTest) return false;
  if (String(conversation.customerExternalId ?? "").startsWith("sandbox:")) return false;
  if (conversation.origin && conversation.origin !== "LIVE") return false;
  return true;
}

/**
 * "message.inbound" (mobile app, 2026-11-03): every inbound customer message
 * in a conversation a PERSON is assigned to goes to that person's phone. The
 * notifications service sends it as push only, to the assignee only. Returns
 * whether it was queued, for the caller's tests; never throws.
 */
export function emitInboundMessage(input: {
  tenantId: string;
  conversation: InboundConversation;
  messageId: string;
  body: string | null | undefined;
  messageType: string | null | undefined;
  channel: string;
  customerName?: string | null;
}): boolean {
  if (!shouldEmitInbound(input.conversation)) return false;
  // null = the team's queue: the engine routes it as an escalation would.
  const assignedAgentId = input.conversation.assignedAgentId ?? null;
  setImmediate(() => {
    try {
      q ??= new Queue("notifications", { connection: { url: REDIS_URL } });
      const id = randomUUID();
      void q
        .add(
          "message.inbound",
          {
            id,
            type: "message.inbound",
            tenantId: input.tenantId,
            departmentId: input.conversation.departmentId ?? undefined,
            data: {
              conversationId: input.conversation.id,
              assignedAgentId,
              // The engine dedups on the payload for five minutes: without the
              // message id, a second "ok" from the same customer would be
              // swallowed as a repeat of the first.
              messageId: input.messageId,
              ...inboundPreview(input.body, input.messageType),
              messageType: input.messageType ?? "text",
              channel: input.channel,
              customerName: input.customerName ?? input.conversation.customerName ?? null,
            },
            metadata: { conversationId: input.conversation.id, userId: assignedAgentId ?? undefined, timestamp: new Date().toISOString() },
          },
          { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 }, jobId: `evt-${id}` },
        )
        .catch((err) => console.warn("[notifications.emit] failed:", err?.message));
    } catch (err: any) {
      console.warn("[notifications.emit] failed:", err?.message);
    }
  });
  return true;
}
