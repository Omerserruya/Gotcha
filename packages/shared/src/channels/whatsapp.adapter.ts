import crypto from "crypto";
import axios from "axios";
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  NormalizedOutboundEcho,
  NormalizedHistoryChunk,
  NormalizedHistoricalMessage,
  SharedContact,
  ChannelCredentials,
  ProviderSendError,
} from "./types";
import { ChannelSendError } from "./types";
import { metaGraphBaseUrl } from "../lib/meta-graph-version";

const WA_API_URL = metaGraphBaseUrl(process.env.WHATSAPP_API_URL);

/**
 * Convert common Markdown to WhatsApp's own formatting so the message reads
 * like a human typed it - not an AI emitting raw Markdown. WhatsApp bold is a
 * SINGLE asterisk (`*bold*`); Markdown's `**bold**` renders as literal
 * asterisks ("****") in the app, which is the dead giveaway we're fixing.
 *
 * Mapping: `**x**`/`__x__` → `*x*` (bold), `# heading` → `*heading*`,
 * `[label](url)` → `label (url)`, `` `code` `` → `code`. Markdown italic
 * (`*x*`) is left alone - it already maps to WhatsApp bold and the models
 * rarely emit single-asterisk italic.
 */
export function formatWhatsAppText(text: string): string {
  if (!text) return text;
  return text
    // Links: [label](https://…) → label (https://…)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    // Bold: **x** / __x__ → *x*  (run before any single-* handling)
    .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
    .replace(/__([^_\n]+?)__/g, "*$1*")
    // ATX headings (#, ##, …) → bold line
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, "*$1*")
    // Inline code `x` → x
    .replace(/`([^`\n]+?)`/g, "$1")
    // Collapse 3+ blank lines that Markdown spacing can introduce
    .replace(/\n{3,}/g, "\n\n");
}

// Meta/WhatsApp error codes that a plain retry could plausibly clear: rate
// limits and transient server-side hiccups. Auth (190/10/2xx), 24h-window
// re-engagement (131047), invalid params (100/131xx business errors) are NOT
// here - retrying those just burns quota. See
// developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes.
const WA_RETRYABLE_CODES = new Set<number>([
  1,      // Unknown/transient API error
  2,      // Temporary service outage
  4,      // App-level rate limit
  613,    // Rate limit hit
  80007,  // Business-use-case rate limit
  130429, // Cloud API message throughput rate limit
  131000, // Something went wrong (Meta-side, generic transient)
  131016, // Service temporarily unavailable
  131056, // Pair rate limit (too many messages to the same number)
]);

function isWaRetryable(httpStatus: number | undefined, code: number | undefined): boolean {
  if (httpStatus != null && (httpStatus === 429 || httpStatus >= 500)) return true;
  if (code != null && WA_RETRYABLE_CODES.has(code)) return true;
  return false;
}

// Build a fully-structured provider error from a WhatsApp/Graph API axios
// failure so NOTHING is lost: HTTP status, Meta code/subcode/type, human
// message + detail, fbtrace_id, request id (x-fb-request-id header) and a
// derived retryability flag. Falls back gracefully for non-HTTP failures
// (network resets, timeouts) which have no Graph error body.
function buildWaSendError(err: any, phase: "send" | "delivery" = "send"): ProviderSendError {
  const response = err?.response;
  const waErr = response?.data?.error;
  const httpStatus: number | undefined =
    typeof response?.status === "number" ? response.status : undefined;
  const requestId: string | undefined =
    response?.headers?.["x-fb-request-id"] || response?.headers?.["x-fb-trace-id"] || undefined;

  if (waErr) {
    const code = typeof waErr.code === "number" ? waErr.code : undefined;
    const subcode = typeof waErr.error_subcode === "number" ? waErr.error_subcode : undefined;
    const title = waErr.error_user_title || waErr.message || waErr.type || "WhatsApp API error";
    const detail = waErr.error_user_msg || waErr.error_data?.details || undefined;
    const codeTag = code != null ? `[${code}${subcode ? "/" + subcode : ""}] ` : "";
    return {
      channel: "WHATSAPP",
      phase,
      httpStatus,
      code,
      subcode,
      type: waErr.type || undefined,
      message: `${codeTag}${title}${detail ? ": " + detail : ""}`,
      detail,
      fbtraceId: waErr.fbtrace_id || undefined,
      requestId,
      retryable: isWaRetryable(httpStatus, code),
      at: new Date().toISOString(),
      raw: waErr,
    };
  }

  // No Graph error body: network-level failure (ECONNRESET/ETIMEDOUT/DNS) or a
  // non-axios throw. Preserve whatever the runtime gave us (err.code is the
  // Node syscall error like "ETIMEDOUT") and treat transport errors as
  // retryable.
  const nodeCode: string | undefined = typeof err?.code === "string" ? err.code : undefined;
  const transport = !!nodeCode && nodeCode !== "ERR_BAD_REQUEST";
  return {
    channel: "WHATSAPP",
    phase,
    httpStatus,
    message: err?.message || (nodeCode ? `WhatsApp transport error (${nodeCode})` : "WhatsApp send failed"),
    detail: nodeCode,
    requestId,
    retryable: transport || (httpStatus != null && httpStatus >= 500),
    at: new Date().toISOString(),
    raw: nodeCode ? { code: nodeCode, message: err?.message } : undefined,
  };
}

// Convert a WhatsApp/Graph delivery-status `errors[]` entry (async webhook)
// into the same structured shape used for synchronous send failures.
function buildWaStatusError(e: any): ProviderSendError {
  const code = typeof e?.code === "number" ? e.code : undefined;
  const subcode = typeof e?.error_subcode === "number" ? e.error_subcode : undefined;
  const title = e?.title || e?.message || e?.error_data?.details || "Delivery failed";
  const detail = e?.error_data?.details || e?.href || undefined;
  const codeTag = code != null ? `[${code}${subcode ? "/" + subcode : ""}] ` : "";
  return {
    channel: "WHATSAPP",
    phase: "delivery",
    code,
    subcode,
    message: `${codeTag}${title}`.trim(),
    detail,
    fbtraceId: e?.fbtrace_id || undefined,
    retryable: isWaRetryable(undefined, code),
    at: new Date().toISOString(),
    raw: e,
  };
}

// ─── Inbound Adapter ─────────────────────────────────────────

/**
 * The ONE Coexistence echo field we ingest: messages the owner sent from the
 * WhatsApp Business app on their phone.
 *
 * Meta also emits `message_echoes`, which mirrors messages sent through the
 * Cloud API - including OUR OWN sends. Ingesting it would post every GOTCHA
 * reply into the thread a second time, because the dedupe key
 * (`Message.externalMessageId`) is written only AFTER the send call returns
 * and the echo can arrive first. It is excluded on purpose; adding it means
 * first giving the outbound path a pre-send idempotency key.
 */
const WA_ECHO_FIELD = "smb_message_echoes";

/**
 * Coexistence chat-history sync. Delivered once, in the minutes after
 * onboarding, and only if the business agreed to share.
 */
const WA_HISTORY_FIELD = "history";

/**
 * Meta's code for "the business turned history sharing off". Not an error on
 * our side and not a broken channel - the customer said no, and the product
 * has to say that rather than showing a failed import.
 */
export const WA_HISTORY_DECLINED_CODE = 2593109;

/**
 * Fields whose `value.metadata.phone_number_id` identifies the channel
 * account. `messages` carries customer traffic and delivery statuses;
 * `smb_message_echoes` carries the business-app echoes; `history` carries the
 * one-time backfill. All must resolve, otherwise the webhook drops the payload
 * before any handler sees it.
 */
const WA_ACCOUNT_BEARING_FIELDS = new Set(["messages", WA_ECHO_FIELD, WA_HISTORY_FIELD]);

export const whatsAppInboundAdapter: InboundAdapter = {
  channel: "WHATSAPP",

  canHandle(body: any): boolean {
    return body?.object === "whatsapp_business_account";
  },

  extractMessages(body: any): NormalizedInboundMessage[] {
    const messages: NormalizedInboundMessage[] = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          const contactName = contacts[0]?.profile?.name || undefined;
          messages.push({
            externalMessageId: msg.id,
            channel: "WHATSAPP",
            senderId: msg.from,
            senderDisplayName: contactName,
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            content: extractWhatsAppContent(msg),
            // `context` is present only when the customer used WhatsApp's
            // reply affordance. It also appears on messages forwarded from a
            // business-initiated template, where `context.forwarded` is set and
            // `id` still points at a real message - so the id is taken and the
            // rest ignored.
            replyToExternalId: msg.context?.id ? String(msg.context.id) : undefined,
          });
        }
      }
    }
    return messages;
  },

  extractStatusUpdates(body: any): NormalizedStatusUpdate[] {
    const updates: NormalizedStatusUpdate[] = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        for (const status of change.value?.statuses || []) {
          const statusMap: Record<string, NormalizedStatusUpdate["status"]> = {
            sent: "sent", delivered: "delivered", read: "read", failed: "failed",
          };
          const mapped = statusMap[status.status];
          if (mapped) {
            // Meta attaches a structured errors[] array on failed deliveries.
            // Surface the first entry as a single human-readable string so
            // the rest of the pipeline can persist it on Message.errorMessage
            // (otherwise the operator sees "FAILED" with no reason).
            let errorMessage: string | undefined;
            let error: ProviderSendError | undefined;
            const errs = Array.isArray(status.errors) ? status.errors : [];
            if (errs.length > 0) {
              error = buildWaStatusError(errs[0]);
              errorMessage = error.message;
            }
            updates.push({
              externalMessageId: status.id,
              status: mapped,
              timestamp: status.timestamp ? new Date(parseInt(status.timestamp) * 1000) : undefined,
              errorMessage,
              error,
            });
          }
        }
      }
    }
    return updates;
  },

  /**
   * Messages the business sent from the WhatsApp Business app (Coexistence).
   * Meta mirrors them here so a number that is live in both places shows one
   * complete thread in GOTCHA.
   *
   * The echo's `to` is the CUSTOMER and its `from` is the business number -
   * the reverse of an inbound message. Keying the conversation off `to` is
   * what puts the echo in the same thread as the customer's own messages
   * rather than opening a conversation "with ourselves".
   */
  extractOutboundEchoes(body: any): NormalizedOutboundEcho[] {
    const echoes: NormalizedOutboundEcho[] = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== WA_ECHO_FIELD) continue;
        const value = change.value || {};
        // Meta has shipped this array under both names; accept either rather
        // than silently ingesting nothing if the payload shape shifts.
        const list = value.message_echoes || value.messages || [];
        for (const msg of list) {
          const to = msg?.to;
          if (!msg?.id || !to) continue;
          echoes.push({
            externalMessageId: msg.id,
            channel: "WHATSAPP",
            customerExternalId: String(to),
            businessExternalId: msg.from ? String(msg.from) : undefined,
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            content: extractWhatsAppContent(msg),
          });
        }
      }
    }
    return echoes;
  },

  /**
   * The business's past conversations, delivered once after Coexistence
   * onboarding.
   *
   * Three things about Meta's shape drive this parser and are worth stating,
   * because getting any of them wrong is silent rather than loud:
   *
   * 1. `phase` / `chunk_order` / `progress` are documented under
   *    `value.metadata` by Meta and under `value.history[].metadata` by
   *    360Dialog. We read BOTH and prefer whichever is present. Reading only
   *    one location yields progress 0 forever and a bar that never moves.
   *
   * 2. Chunks ARRIVE OUT OF ORDER. Meta says so explicitly and tells partners
   *    to re-sequence by `chunk_order`, which is why it is carried through
   *    rather than assumed from arrival.
   *
   * 3. `threads[].id` is the CUSTOMER's number, and each thread mixes both
   *    directions. Direction comes from comparing `from` against the business
   *    number in `value.metadata.display_phone_number` - never from assuming
   *    a historical message is inbound.
   *
   * A business that declined sharing produces an `errors[]` entry instead of
   * threads. That is surfaced as `unavailable`, not thrown: it is an answer,
   * not a fault.
   */
  extractHistorySync(body: any): NormalizedHistoryChunk[] {
    const chunks: NormalizedHistoryChunk[] = [];
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (change?.field !== WA_HISTORY_FIELD) continue;
        const value = change.value || {};
        const outerMeta = value.metadata || {};
        const accountExternalId = String(outerMeta.phone_number_id || "");
        if (!accountExternalId) continue;

        // Digits only: Meta writes the business number with and without a
        // leading "+" depending on the field, and a direction check that
        // depends on punctuation is a direction check that will be wrong.
        const businessNumber = digitsOnly(outerMeta.display_phone_number);

        for (const historyEntry of value.history || []) {
          const innerMeta = historyEntry?.metadata || {};
          const errors = Array.isArray(historyEntry?.errors) ? historyEntry.errors : [];

          const phase = firstNumber(innerMeta.phase, outerMeta.phase) ?? 0;
          const chunkOrder = firstNumber(innerMeta.chunk_order, outerMeta.chunk_order) ?? 0;
          const progress = firstNumber(innerMeta.progress, outerMeta.progress) ?? 0;

          if (errors.length > 0) {
            const err = errors[0] || {};
            chunks.push({
              channel: "WHATSAPP",
              accountExternalId,
              phase,
              chunkOrder,
              progress,
              messages: [],
              threadCount: 0,
              unavailable: {
                code: typeof err.code === "number" ? err.code : undefined,
                reason:
                  err.error_data?.details ||
                  err.title ||
                  err.message ||
                  "The source did not provide chat history",
              },
            });
            continue;
          }

          const messages: NormalizedHistoricalMessage[] = [];
          const threads = Array.isArray(historyEntry?.threads) ? historyEntry.threads : [];
          for (const thread of threads) {
            const customerExternalId = String(thread?.id || "");
            if (!customerExternalId) continue;
            for (const msg of thread?.messages || []) {
              if (!msg?.id) continue;
              const from = digitsOnly(msg.from);
              // Compared against the business number rather than against the
              // thread id: a message can be `from` the business to the
              // customer, or from the customer to the business, and only one
              // of those two endpoints is stable across every thread.
              const direction: "INBOUND" | "OUTBOUND" =
                businessNumber && from === businessNumber ? "OUTBOUND" : "INBOUND";
              messages.push({
                externalMessageId: String(msg.id),
                customerExternalId,
                direction,
                timestamp: parseSourceTimestamp(msg.timestamp),
                content: extractWhatsAppContent(msg),
                sourceStatus: msg.history_context?.status
                  ? String(msg.history_context.status)
                  : undefined,
              });
            }
          }

          chunks.push({
            channel: "WHATSAPP",
            accountExternalId,
            phase,
            chunkOrder,
            progress,
            messages,
            threadCount: threads.length,
          });
        }
      }
    }
    return chunks;
  },

  resolveChannelAccountExternalId(body: any): string | null {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (!WA_ACCOUNT_BEARING_FIELDS.has(change.field)) continue;
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (phoneNumberId) return phoneNumberId;
      }
    }
    return null;
  },

  verifySignature(appSecret: string, rawBody: Buffer, signature: string): boolean {
    const expectedSig = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(`sha256=${expectedSig}`), Buffer.from(signature));
    } catch {
      return false;
    }
  },

  getSignatureHeader(): string {
    return "x-hub-signature-256";
  },
};

/**
 * Reduce Meta's contact payload to what an agent can act on.
 *
 * Meta's shape is a full vCard: name broken into five parts, addresses, urls,
 * birthdays. Almost none of it helps somebody answering a message, and copying
 * it wholesale would put a customer's relatives' home addresses into our
 * database for no benefit. Name, numbers, emails and organization only.
 *
 * `wa_id` is kept where Meta provides it, because that is the difference
 * between a number an agent has to type somewhere and one they can open a
 * conversation with.
 */
function extractWhatsAppContacts(raw: unknown): SharedContact[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedContact[] = [];
  for (const c of raw.slice(0, 5)) {
    if (!c || typeof c !== "object") continue;
    const any = c as any;
    const name =
      any.name?.formatted_name ||
      [any.name?.first_name, any.name?.last_name].filter(Boolean).join(" ") ||
      "";
    const phones = Array.isArray(any.phones)
      ? any.phones
          .filter((p: any) => p?.phone)
          .slice(0, 5)
          .map((p: any) => ({
            number: String(p.phone),
            type: p.type ? String(p.type) : undefined,
            waId: p.wa_id ? String(p.wa_id) : undefined,
          }))
      : [];
    const emails = Array.isArray(any.emails)
      ? any.emails
          .filter((e: any) => e?.email)
          .slice(0, 5)
          .map((e: any) => ({
            address: String(e.email),
            type: e.type ? String(e.type) : undefined,
          }))
      : [];
    if (!name && phones.length === 0 && emails.length === 0) continue;
    out.push({
      name,
      phones,
      emails,
      organization: any.org?.company ? String(any.org.company) : undefined,
    });
  }
  return out;
}

/** Digits only, so "+972 50-123-4567" and "972501234567" compare equal. */
function digitsOnly(v: unknown): string {
  return typeof v === "string" || typeof v === "number"
    ? String(v).replace(/\D/g, "")
    : "";
}

/**
 * First value that is actually a number. Meta documents the history counters in
 * one place and 360Dialog in another, so both are offered here and the present
 * one wins. `0` is a legitimate value (phase 0, chunk 0, progress 0), which is
 * why this cannot be a `||` chain.
 */
function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/**
 * History timestamps are the DEVICE's, in seconds, and occasionally absent or
 * junk on very old messages. An unparseable one yields the epoch rather than
 * `Invalid Date`, which Postgres rejects outright - losing the true date of one
 * ancient message is a far smaller loss than failing the chunk it sits in.
 */
function parseSourceTimestamp(raw: unknown): Date {
  const seconds = firstNumber(raw);
  if (seconds === undefined) return new Date(0);
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function extractWhatsAppContent(msg: any): NormalizedInboundMessage["content"] {
  switch (msg.type) {
    case "text":
      return { type: "text", text: msg.text?.body || "" };
    case "interactive":
      return {
        type: "interactive",
        text: "",
        interactiveReply: {
          type: "button",
          payload: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "",
          title: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "",
        },
      };
    case "image":
      return {
        type: "image",
        mediaUrl: msg.image?.id,
        caption: msg.image?.caption || "[Image]",
        mimeType: msg.image?.mime_type,
      };
    case "document":
      return {
        type: "document",
        mediaUrl: msg.document?.id,
        // The sender's own filename is the only human-readable thing about a
        // document, and WhatsApp gives it to us. Preferring it over the
        // literal "[Document]" is the difference between a row that says what
        // arrived and one that says a file did.
        caption: msg.document?.caption || msg.document?.filename || "[Document]",
        fileName: msg.document?.filename,
        mimeType: msg.document?.mime_type,
      };
    case "audio":
      // `mediaUrl` was missing here, which is why voice notes were
      // unrecoverable: the id is the ONLY handle on the file, Meta expires the
      // media after a few days, and without it the recording is gone for good.
      return {
        type: "audio",
        mediaUrl: msg.audio?.id,
        text: msg.audio?.voice ? "[Voice message]" : "[Audio message]",
        mimeType: msg.audio?.mime_type,
        voice: !!msg.audio?.voice,
      };
    case "video":
      return {
        type: "video",
        mediaUrl: msg.video?.id,
        caption: msg.video?.caption || "[Video]",
        mimeType: msg.video?.mime_type,
      };
    case "sticker":
      // A sticker is an image (webp, often animated). Treated as one so it
      // renders instead of printing "[sticker message]" as dead text.
      return { type: "image", mediaUrl: msg.sticker?.id, caption: "[Sticker]", mimeType: msg.sticker?.mime_type };
    case "location":
      return { type: "location", text: `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]` };
    case "contacts": {
      // "Send a contact" from the WhatsApp attach menu. Arrives as an array,
      // because a customer can share several at once.
      //
      // Kept structured. The point of a shared contact is that somebody can
      // ring it - a customer sending their partner's number so a delivery can
      // be arranged is common, and flattening it into text was throwing that
      // away and rendering the literal string "[contacts message]".
      const cards = extractWhatsAppContacts(msg.contacts);
      if (cards.length === 0) return { type: "text", text: "[Contact]" };
      const summary =
        cards.length === 1
          ? cards[0].name || cards[0].phones[0]?.number || "[Contact]"
          : `${cards[0].name || "[Contact]"} +${cards.length - 1}`;
      return { type: "contact", text: summary, contacts: cards };
    }
    default:
      return { type: "text", text: `[${msg.type || "unknown"} message]` };
  }
}

// ─── Outbound Adapter ────────────────────────────────────────

export const whatsAppOutboundAdapter: OutboundAdapter = {
  channel: "WHATSAPP",

  async sendTextMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    text: string,
    replyToExternalId?: string,
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        {
          messaging_product: "whatsapp",
          to: recipientId,
          type: "text",
          text: { body: formatWhatsAppText(text) },
          // `context.message_id` is what makes this render as a reply in the
          // customer's WhatsApp, quoting the message above it. Meta rejects the
          // send outright if the id is not a real message in this thread, which
          // is why the caller validates it against the conversation first.
          ...(replyToExternalId ? { context: { message_id: replyToExternalId } } : {}),
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new ChannelSendError(buildWaSendError(err));
    }
  },

  async sendInteractiveMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<string | null> {
    try {
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        {
          messaging_product: "whatsapp", to: recipientId, type: "interactive",
          interactive: {
            type: "button", body: { text: formatWhatsAppText(bodyText) },
            action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
          },
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new ChannelSendError(buildWaSendError(err));
    }
  },

  async sendMediaMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    mediaUrl: string,
    mediaType: "image" | "video" | "document",
    fileName?: string,
    caption?: string
  ): Promise<string | null> {
    try {
      const mediaPayload: Record<string, any> = { link: mediaUrl };
      if (caption) mediaPayload.caption = caption;
      if (mediaType === "document" && fileName) mediaPayload.filename = fileName;

      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        {
          messaging_product: "whatsapp",
          to: recipientId,
          type: mediaType,
          [mediaType]: mediaPayload,
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new ChannelSendError(buildWaSendError(err));
    }
  },

  async sendTemplateMessage(
    credentials: ChannelCredentials,
    accountExternalId: string,
    recipientId: string,
    templateName: string,
    language: string,
    components?: any[]
  ): Promise<string | null> {
    try {
      const payload: any = {
        messaging_product: "whatsapp",
        to: recipientId,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
        },
      };
      if (components && components.length > 0) {
        payload.template.components = components;
      }
      const response = await axios.post(
        `${WA_API_URL}/${accountExternalId}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json" } }
      );
      return response.data?.messages?.[0]?.id || null;
    } catch (err: any) {
      throw new ChannelSendError(buildWaSendError(err));
    }
  },
};
