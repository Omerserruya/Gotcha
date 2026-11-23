/**
 * The conversation the model reads (2026-10-25).
 *
 * `loadRecentHistory` is the LAST `limit` messages, oldest first. The bot used
 * to read `orderBy asc, take 50`: the FIRST 50. Past message 50 the model never
 * saw the newest turns, the customer's current message included (prod: 169
 * conversations over 50 messages, 627 replies written blind in 7 of them).
 *
 * `historyChatMessages` turns those rows into the chat turns the model sees,
 * saying who wrote what: the customer (user), the employee itself (assistant),
 * and a human colleague (user side, labelled, so the model neither owns their
 * words nor imitates them as its own). Media and product cards become markers,
 * and a long silence becomes a note, so the model knows a new day began.
 *
 * `buildStateNote` is the per-turn facts the model would otherwise have to
 * infer from the transcript, computed here and placed right before generation:
 * the time, whether it already greeted today, how its last replies began, the
 * customer's grammatical form, and open commitments.
 */
import { prisma } from "@chatcenter/shared";

export const BOT_HISTORY_LIMIT = 50;
/**
 * Messages the model reads verbatim. 40, not 30 (eval L01: the size asked in
 * turn 1 had fallen out and the model answered with a later one). Older ones
 * become a short note (earlierNote) and still feed the turn's other signals.
 */
export const HISTORY_WINDOW = 40;
/** A silence this long gets a note in the transcript. */
export const GAP_NOTE_MS = 6 * 60 * 60_000;
export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

export interface HistoryRow {
  direction: string;
  body: string | null;
  messageType?: string | null;
  senderName?: string | null;
  createdAt?: Date | string | null;
  metadata?: unknown;
  origin?: string | null;
}

type ChatTurn = { role: "user" | "assistant" | "system"; content: string };

export async function loadRecentHistory<T = any>(
  tenantId: string,
  conversationId: string,
  limit = BOT_HISTORY_LIMIT,
): Promise<T[]> {
  const newestFirst = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return (newestFirst as T[]).reverse();
}

/**
 * Who wrote an outbound message. `senderName` is the only record: a person
 * typing is always their email; the product writes "AI Bot", "System",
 * "Broadcast" or the employee's own name. An allow-list on "@" fails by missing
 * a human (cheap), never by treating the bot as one.
 */
export function isHumanAgent(row: HistoryRow): boolean {
  return row.direction === "OUTBOUND" && typeof row.senderName === "string" && row.senderName.includes("@");
}

/**
 * The owner writing from the WhatsApp Business app: an echo (Coexistence) or
 * imported history (before the connection every business-side message was the
 * app). Same rule as the worker's owner-recent check.
 */
export function isOwnerFromPhone(row: HistoryRow): boolean {
  if (row.direction !== "OUTBOUND") return false;
  return row.origin === "HISTORICAL_IMPORT" || (row.metadata as any)?.source === "whatsapp_business_app";
}

/** A person on the business side wrote it: the inbox (an email) or the phone. */
export const isPersonOutbound = (row: HistoryRow) => isHumanAgent(row) || isOwnerFromPhone(row);

function humanName(senderName: string): string {
  const local = senderName.split("@")[0].split(/[._+-]/)[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
}

const MEDIA_KIND: Record<string, string> = {
  image: "a photo", video: "a video", audio: "a voice or audio message", voice: "a voice message",
  sticker: "a sticker", document: "a document", file: "a file",
};

/** The adapters' stand-in text for a media message with no caption. */
const PLACEHOLDER_BODY = /^\[(?:image|video|audio message|voice message|sticker|document|file|media)[^\]]*\]$/i;

const at = (v: HistoryRow["createdAt"]): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

function localStamp(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

export function describeGap(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 36) return `${h} hours`;
  const d = Math.round(ms / 86_400_000);
  return d === 1 ? "1 day" : `${d} days`;
}

function render(row: HistoryRow): ChatTurn | null {
  const body = (row.body ?? "").trim();
  const type = (row.messageType ?? "text").toLowerCase();
  if (type === "system") return null;

  if (row.direction === "INBOUND") {
    const kind = MEDIA_KIND[type];
    if (kind) {
      const caption = body && !PLACEHOLDER_BODY.test(body) ? ` Their caption: "${body}"` : "";
      return { role: "user", content: `[The customer sent ${kind}. You cannot see or hear its content; never say or imply that you did.]${caption}` };
    }
    return body ? { role: "user", content: body } : null;
  }

  // Outbound: a human colleague, or the employee itself.
  if (isPersonOutbound(row)) {
    const name = isHumanAgent(row) ? humanName(row.senderName!) : "";
    const who = name ? `Human team member ${name}` : isOwnerFromPhone(row) ? "The business owner (from the phone)" : "Human team member";
    const kind = MEDIA_KIND[type];
    const text = kind ? `(sent ${kind})${body && !PLACEHOLDER_BODY.test(body) ? ` ${body}` : ""}` : body;
    return text ? { role: "user", content: `[${who}, not you, wrote to the customer]: ${text}` } : null;
  }
  if (/product/.test(type)) {
    const items = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return items.length ? { role: "assistant", content: `[Product cards shown to the customer: ${items.join("; ")}]` } : null;
  }
  const kind = MEDIA_KIND[type];
  if (kind) return { role: "assistant", content: `[You sent ${kind}]${body && !PLACEHOLDER_BODY.test(body) ? ` ${body}` : ""}` };
  return body ? { role: "assistant", content: body } : null;
}

export function historyChatMessages(
  rows: HistoryRow[],
  opts: { window?: number; timeZone?: string } = {},
): ChatTurn[] {
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const window = opts.window ?? HISTORY_WINDOW;
  const shown = rows.slice(-window);
  const out: ChatTurn[] = [];
  const earlier = earlierNote(rows.slice(0, Math.max(0, rows.length - window)));
  if (earlier) out.push({ role: "system", content: earlier });
  let prevAt: number | null = null;
  for (const row of shown) {
    const turn = render(row);
    if (!turn) continue;
    const t = at(row.createdAt);
    if (t !== null && prevAt !== null && t - prevAt >= GAP_NOTE_MS) {
      out.push({ role: "system", content: `[${describeGap(t - prevAt)} passed with no messages. The next message is from ${localStamp(t, timeZone)}.]` });
    }
    if (t !== null) prevAt = t;
    out.push(turn);
  }
  return out;
}

/**
 * What fell out of the window, kept as facts: the products shown, and the
 * customer's own short messages there (a size, a colour, a yes).
 */
export function earlierNote(older: HistoryRow[]): string | null {
  if (!older.length) return null;
  const cards: string[] = [];
  const said: string[] = [];
  for (const r of older) {
    const body = (r.body ?? "").trim();
    if (!body) continue;
    if (r.direction === "OUTBOUND" && /product/.test(String(r.messageType ?? ""))) {
      for (const l of body.split("\n").map((x) => x.trim()).filter(Boolean)) if (!cards.includes(l)) cards.push(l);
    } else if (r.direction === "INBOUND" && body.length <= 60 && (r.messageType ?? "text") === "text") {
      said.push(body);
    }
  }
  if (!cards.length && !said.length) return null;
  const lines = ["[Earlier in this conversation, before the messages below:"];
  if (cards.length) lines.push(`- products shown: ${cards.slice(-8).join("; ")}`);
  if (said.length) lines.push(`- the customer said, in order: ${said.slice(-12).map((x) => `"${x}"`).join(", ")}`);
  lines.push("Use these as facts; a size or colour said there belongs to the product being discussed then.]");
  return lines.join("\n");
}

// ── The per-turn state note ─────────────────────────────────────────────

const GREETING = /^(?:היי+|הי|שלום|אהלן|הלו|בוקר טוב|ערב טוב|צהריים טובים|לילה טוב|hi+|hey+|hello|good (?:morning|afternoon|evening))(?=[\s,.!?:;🙂😊]|$)/iu;
/** Commitments a reply can make: a time, a follow-up, an action promised. */
const PROMISE = /(?:אחזור אלי|נחזור אלי|אעדכן|נעדכן|אבדוק ואחזור|נבדוק ונחזור|אדאג|נדאג|אשלח|נשלח|תקבל|תקבלי|תקבלו|מחר|עד סוף היום|I(?:'ll| will) (?:get back|update|send|check)|we(?:'ll| will) (?:get back|update|send))/i;

function firstWords(text: string, n = 2): string {
  return text.trim().split(/\s+/).slice(0, n).join(" ").replace(/[,.!?:;]+$/, "");
}

export interface StateNoteInput {
  rows: HistoryRow[];
  now: number;
  timeZone?: string;
  /** The customer's grammatical form, as the address tracker holds it. */
  customerForm?: { form: string; confidence: string } | null;
  /** The employee's setting: "feminine" addresses every customer in the feminine (Omer 2026-11-23); else neutral. */
  addressForm?: "feminine" | null;
}

export function buildStateNote(input: StateNoteInput): string {
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;
  const rows = input.rows.filter((r) => (r.messageType ?? "text") !== "system");
  const lines: string[] = [`# State right now (facts, computed by the system)`];
  lines.push(`- Local time: ${localStamp(input.now, timeZone)} (${timeZone}).`);

  const inbound = rows.filter((r) => r.direction === "INBOUND");
  const current = inbound.at(-1);
  const prevInbound = inbound.at(-2);
  const currentAt = at(current?.createdAt) ?? input.now;
  const prevAt = at(prevInbound?.createdAt);
  if (prevAt !== null && currentAt - prevAt >= GAP_NOTE_MS) {
    lines.push(`- The customer's previous message was ${describeGap(currentAt - prevAt)} before this one.`);
  }

  // Greeting: anything said to the customer today counts, by us or a colleague.
  const ours = rows.filter((r) => r.direction === "OUTBOUND" && !/product/.test((r.messageType ?? "").toLowerCase()));
  const today = localDay(input.now, timeZone);
  const firstToday = ours.find((r) => { const t = at(r.createdAt); return t !== null && localDay(t, timeZone) === today; });
  if (firstToday) {
    lines.push(`- This conversation already spoke to the customer today (from ${localTime(at(firstToday.createdAt)!, timeZone)}). Do NOT greet and do not introduce yourself: answer directly.`);
  } else if (ours.length) {
    lines.push(`- Nothing was said to the customer yet today. One short greeting is fine if it fits, then the answer. Do not introduce yourself again.`);
  } else {
    lines.push(`- This is the first reply in the conversation. A short greeting is fine, then the answer.`);
  }

  // How the employee's own recent replies began: start this one differently.
  const mine = ours.filter((r) => !isHumanAgent(r) && (r.body ?? "").trim()).slice(-2);
  if (mine.length) {
    const starts = mine.map((r) => `"${firstWords(r.body!)}"`).join(" and ");
    lines.push(`- Your last ${mine.length === 1 ? "reply" : "replies"} began with ${starts}. Begin this one differently, ideally with the substance itself.`);
    if (mine.some((r) => GREETING.test(r.body!.trim()))) lines.push(`- You already greeted in a recent reply: never greet twice.`);
  }

  // The customer's grammatical form, only from their own words.
  // Always neutral, even when they wrote "אני מחפשת" (Omer, 2026-10-26; eval e11).
  lines.push(input.addressForm === "feminine"
    // The business's own setting (2026-11-23): its customers are addressed in the feminine.
    ? `- Address the customer in the feminine form (the business's setting): "תרצי", "את מחפשת", "שלחי לי", "בשבילך"; never the masculine, never a slash form.`
    : `- Address the customer neutrally (no gendered verbs, participles or pronouns, no slash forms), whatever form they use about themselves.`);

  // Open commitments: things already promised in this conversation.
  const promises = ours.slice(-12).filter((r) => PROMISE.test(r.body ?? "")).slice(-3);
  if (promises.length) {
    lines.push(`- Commitments already made in this conversation (honour them, never contradict them):`);
    for (const p of promises) {
      const who = isHumanAgent(p) ? `a human colleague (${humanName(p.senderName!) || "team"})` : "you";
      lines.push(`  - ${who}: "${(p.body ?? "").trim().slice(0, 160)}"`);
    }
  }
  return lines.join("\n");
}
