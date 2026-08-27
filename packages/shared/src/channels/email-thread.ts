/**
 * Email threading: making a reply from the inbox land in the customer's
 * existing thread instead of starting a new one.
 *
 * Every other channel here has a native notion of a conversation. Email does
 * not. A mail client decides two messages belong together by reading three
 * things off the headers:
 *
 *   * `In-Reply-To` - the Message-ID of the message being answered
 *   * `References`  - the whole ancestry, oldest first
 *   * `Subject`     - which has to still look like the same subject
 *
 * Send without those and the customer gets a second, unrelated email. That is
 * exactly what GOTCHA did: both mail adapters hard-coded `Subject: "Message"`
 * and set no threading headers at all, so a support reply arrived as a brand
 * new message titled "Message", detached from the question it answered.
 *
 * The provider's own thread id (Gmail `threadId`, Graph `conversationId`) is
 * carried alongside the headers rather than instead of them. It is the more
 * reliable signal at the sending provider, and the headers are what every OTHER
 * mail client in the chain reads. Both, or the thread holds on one side only.
 */

/** What we record about an email when it arrives, kept on Message.metadata.email. */
export interface EmailMessageMeta {
  /** RFC 5322 `Message-ID` of this email, angle brackets included. */
  messageIdHeader?: string;
  /** The `References` chain this email carried, oldest first. */
  references?: string[];
  /** The subject line as it arrived, with any `Re:` still on it. */
  subject?: string;
  /** The provider's thread id: Gmail `threadId`, Graph `conversationId`. */
  threadId?: string;
  /** The provider's id for the message itself, which Graph's reply API needs. */
  providerMessageId?: string;
}

/** Everything an adapter needs to make one send join an existing thread. */
export interface EmailThreadContext {
  /** The exact subject line to send. Already carries `Re:` when it is a reply. */
  subject: string;
  /** Message-ID of the message being answered. */
  inReplyTo?: string;
  /** Full ancestry to send as `References`, oldest first. */
  references?: string[];
  /** Gmail `threadId` / Graph `conversationId`. */
  threadId?: string;
  /** Graph message id, so Outlook can use its own reply endpoint. */
  providerMessageId?: string;
}

/**
 * The subject used when there is nothing to reply to and nobody supplied one.
 *
 * Deliberately not the old hard-coded "Message": a subject line is the first
 * thing a customer reads in their list, and "Message" tells them nothing and
 * looks like spam.
 */
export const DEFAULT_EMAIL_SUBJECT = "Message from support";

/**
 * References chains grow forever on a long thread and some servers reject an
 * oversized header. RFC 5322 allows trimming the middle; the first message
 * anchors the thread and the most recent ones are what clients actually match
 * on, so those are the ones kept.
 */
const MAX_REFERENCES = 20;
const MAX_SUBJECT_LENGTH = 200;

/** Matches one leading reply marker: `Re:`, `RE :`, `Re[2]:`, `Re(3):`. */
const REPLY_PREFIX = /^\s*re\s*(?:[[(]\d+[\])])?\s*:\s*/i;

/**
 * The subject with every accumulated `Re:` stripped.
 *
 * Repeated because a thread that has bounced between clients arrives as
 * "Re: Re: RE: Order 123", and prefixing that again is how a subject line ends
 * up wider than the screen.
 */
export function baseSubject(subject: string | undefined | null): string {
  let s = (subject || "").trim();
  let guard = 10;
  while (guard-- > 0 && REPLY_PREFIX.test(s)) s = s.replace(REPLY_PREFIX, "").trim();
  return s;
}

/** The subject to send when answering `subject`. */
export function replySubject(subject: string | undefined | null): string {
  const base = baseSubject(subject);
  if (!base) return DEFAULT_EMAIL_SUBJECT;
  return truncateSubject(`Re: ${base}`);
}

export function truncateSubject(subject: string): string {
  return subject.length <= MAX_SUBJECT_LENGTH
    ? subject
    : `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

/**
 * Split a raw `References` / `In-Reply-To` header into ids.
 *
 * Whitespace-separated in the wild, sometimes comma-separated by a
 * non-compliant sender, so both are accepted. Anything that is not an
 * angle-bracketed id is dropped rather than passed through: a malformed entry
 * in this header breaks threading for the whole chain.
 */
export function parseMessageIdList(header: string | undefined | null): string[] {
  if (!header) return [];
  return header
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("<") && s.endsWith(">") && s.length > 2);
}

/** The ancestry to send when replying to a message that carried `refs` and has id `parentId`. */
export function buildReferences(refs: string[] | undefined, parentId: string | undefined): string[] {
  const chain = [...(refs || [])];
  if (parentId && !chain.includes(parentId)) chain.push(parentId);
  if (chain.length <= MAX_REFERENCES) return chain;
  // Keep the root and the most recent tail; the middle is what clients ignore.
  return [chain[0], ...chain.slice(chain.length - (MAX_REFERENCES - 1))];
}

/** Read the email metadata off a Message row without trusting its shape. */
export function readEmailMeta(metadata: unknown): EmailMessageMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const email = (metadata as any).email;
  if (!email || typeof email !== "object") return null;
  return {
    messageIdHeader: typeof email.messageIdHeader === "string" ? email.messageIdHeader : undefined,
    references: Array.isArray(email.references) ? email.references.filter((r: any) => typeof r === "string") : undefined,
    subject: typeof email.subject === "string" ? email.subject : undefined,
    threadId: typeof email.threadId === "string" ? email.threadId : undefined,
    providerMessageId: typeof email.providerMessageId === "string" ? email.providerMessageId : undefined,
  };
}

export interface EmailThreadSourceMessage {
  direction: "INBOUND" | "OUTBOUND" | string;
  metadata?: unknown;
}

/**
 * Work out how to answer a conversation, from the emails already in it.
 *
 * `messages` is expected newest-first, which is the order the inbox reads them
 * in. The newest INBOUND email is the one being answered: replying to our own
 * last outbound would thread correctly but quote the wrong parent, and a
 * customer who sent three follow-ups should get the answer under the last one.
 *
 * Returns null when the conversation holds no email we can thread onto - a
 * brand new outbound, or a conversation whose emails predate this recording.
 * The caller then sends a normal first message rather than a broken reply.
 */
export function resolveEmailThread(
  messages: EmailThreadSourceMessage[],
  opts: { subjectFallback?: string } = {},
): EmailThreadContext | null {
  let parent: EmailMessageMeta | null = null;
  let anySubject: string | undefined;
  let anyThreadId: string | undefined;

  for (const m of messages) {
    const meta = readEmailMeta(m.metadata);
    if (!meta) continue;
    // Remember these from either direction: an outbound-only conversation can
    // still hold the thread id and subject we started with.
    anySubject ??= meta.subject;
    anyThreadId ??= meta.threadId;
    if (m.direction === "INBOUND" && !parent) parent = meta;
  }

  if (!parent) {
    // No inbound email to answer. If we at least know the thread, stay in it.
    if (!anyThreadId && !anySubject) return null;
    return {
      subject: replySubject(anySubject || opts.subjectFallback),
      threadId: anyThreadId,
    };
  }

  return {
    subject: replySubject(parent.subject || anySubject || opts.subjectFallback),
    inReplyTo: parent.messageIdHeader,
    references: buildReferences(parent.references, parent.messageIdHeader),
    threadId: parent.threadId,
    providerMessageId: parent.providerMessageId,
  };
}

/**
 * The headers a reply has to carry, as lines ready to join into a raw message.
 *
 * Only emitted when there is something to point at: an empty `In-Reply-To` is
 * worse than an absent one, because some servers treat the malformed header as
 * a reason to reject the message.
 */
export function threadHeaderLines(thread: EmailThreadContext | undefined): string[] {
  if (!thread) return [];
  const lines: string[] = [];
  if (thread.inReplyTo) lines.push(`In-Reply-To: ${thread.inReplyTo}`);
  if (thread.references?.length) lines.push(`References: ${thread.references.join(" ")}`);
  return lines;
}

/** The subject to put on a send, whether it is a reply or a fresh email. */
export function outgoingSubject(
  thread: EmailThreadContext | undefined,
  fallback?: string,
): string {
  if (thread?.subject) return truncateSubject(thread.subject);
  const base = baseSubject(fallback);
  return base ? truncateSubject(base) : DEFAULT_EMAIL_SUBJECT;
}
