/**
 * A website-chat conversation exists from the visitor's first message, not
 * from opening the widget (prod 2026-11-09: 13 WEBCHAT conversations with no
 * message, two of them Smoovee's, sitting in the inbox).
 *
 * The bundle opens or resumes through /init. A returning visitor whose stored
 * conversation was closed made /init create a new, empty one on every such
 * open. Now /init answers with a DRAFT: a conversation id minted here and a
 * token that proves it, nothing written. The first /message (or "talk to a
 * person", or "continue on WhatsApp") creates the conversation under that
 * same id, so the widget's stored id, its poll and its socket all keep working
 * without a widget change.
 *
 * The token carries the widget's channel account and an HMAC over (id,
 * account): only a draft this server minted can be created, and only on the
 * widget it was minted for. No secret configured: null, and /init creates the
 * conversation as it always did.
 */
import crypto from "crypto";

const TOKEN_RE = /^sess_([0-9a-f]{32})_([A-Za-z0-9_-]{4,64})$/;
const ID_RE = /^c[0-9a-f]{24}$/;

function draftKey(): Buffer | null {
  const secret = process.env.CHANNEL_ENCRYPTION_KEY;
  return secret ? crypto.createHmac("sha256", secret).update("webchat-draft:v1").digest() : null;
}

function mac(key: Buffer, id: string, channelAccountId: string): string {
  return crypto.createHmac("sha256", key).update(`${id}|${channelAccountId}`).digest("hex").slice(0, 32);
}

/** A draft for this widget: { id, token }, or null when no key is configured. */
export function mintWebchatDraft(channelAccountId: string): { id: string; token: string } | null {
  const key = draftKey();
  if (!key || !channelAccountId) return null;
  const id = `c${crypto.randomBytes(12).toString("hex")}`;
  return { id, token: `sess_${mac(key, id, channelAccountId)}_${channelAccountId}` };
}

/** The channel account a genuine draft (id, token) was minted for; null otherwise. */
export function draftChannelAccount(id: unknown, token: unknown): string | null {
  if (typeof id !== "string" || typeof token !== "string" || !ID_RE.test(id)) return null;
  const m = TOKEN_RE.exec(token);
  const key = draftKey();
  if (!m || !key) return null;
  const want = Buffer.from(mac(key, id, m[2]));
  const got = Buffer.from(m[1]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[2] : null;
}

/** "Visitor from smoovee-ltd.com" from the page's origin, as /init named it. */
export function visitorNameFromOrigin(origin: unknown): string {
  try {
    const host = new URL(String(origin ?? "")).hostname.replace(/^www\./, "");
    return host && /^[a-z0-9.-]{1,80}$/i.test(host) ? `Visitor from ${host}` : "Website Visitor";
  } catch {
    return "Website Visitor";
  }
}

/**
 * Create the draft's conversation (first message). The widget must still be a
 * live WEBCHAT account. Two messages racing: the second finds the first's row.
 */
export async function createDraftConversation(
  db: any,
  opts: { id: string; token: string; channelAccountId: string; customerName: string },
): Promise<boolean> {
  const account = await db.channelAccount.findFirst({
    where: { id: opts.channelAccountId, channel: "WEBCHAT", connectionStatus: { in: ["CONNECTED", "PENDING"] } },
    select: { id: true, tenantId: true },
  });
  if (!account) return false;
  try {
    await db.conversation.create({
      data: {
        id: opts.id,
        tenantId: account.tenantId,
        channelAccountId: account.id,
        channel: "WEBCHAT",
        customerExternalId: opts.token,
        customerName: opts.customerName,
        status: "OPEN",
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
  }
  console.log(`[embedded-chat][draft] conversation created on first use conv=${opts.id}`);
  return true;
}
