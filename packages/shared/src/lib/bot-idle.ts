/**
 * Bot idle: the conversations only the AI employee answers are reminded and closed (2026-11-19, Omer:
 * conversations never got closed; one business had a row, every other one had none).
 *
 * One place for the numbers, the texts, the stored shape and the reopen rule. Read by the sweep
 * (incoming-worker idle-conversation.worker), the settings route (auth agents.ts), the inbound paths that
 * reopen (incoming.worker, the website widget) and the reply engine (the end mark).
 *
 * Stored: TenantSetting "botIdleAutomation". Two shapes live in one row, no migration:
 *   - the first shape, flat: { reminderEnabled, reminderDelayMinutes, reminderMessage, autoCloseEnabled,
 *     autoCloseDelayMinutes, autoCloseMessage, channels }. It rules the channels it lists.
 *   - groups: { liveChat?: BotIdleGroupValues, messaging?: BotIdleGroupValues }. A saved group rules every
 *     channel of the group, ahead of the flat shape.
 * A channel no part of the row rules follows the default, when the default is switched on (botIdleDefaultOn).
 */

export const BOT_IDLE_KEY = "botIdleAutomation";

export const BOT_IDLE_GROUPS = ["liveChat", "messaging"] as const;
export type BotIdleGroup = (typeof BOT_IDLE_GROUPS)[number];

export const BOT_IDLE_GROUP_CHANNELS: Record<BotIdleGroup, readonly string[]> = {
  liveChat: ["WEBCHAT", "SHOPIFY_LIVE_CHAT"],
  messaging: ["WHATSAPP", "INSTAGRAM", "MESSENGER"],
};
export const BOT_IDLE_CHANNELS: readonly string[] = BOT_IDLE_GROUPS.flatMap((g) => BOT_IDLE_GROUP_CHANNELS[g]);

export const botIdleGroupOf = (channel: string | null | undefined): BotIdleGroup | null =>
  BOT_IDLE_GROUPS.find((g) => BOT_IDLE_GROUP_CHANNELS[g].includes(String(channel ?? ""))) ?? null;

/** The same ceiling as the person-held setting: one week. */
export const BOT_IDLE_DELAY_MAX_MINUTES = 10080;
export const BOT_IDLE_TEXT_MAX = 1000;

/**
 * The default numbers (Omer 2026-11-19). The reminder counts from our last message the customer did not
 * answer; the close counts from the reminder.
 */
export const BOT_IDLE_DEFAULT_MINUTES: Record<BotIdleGroup, { reminderAfter: number; closeAfterReminder: number }> = {
  liveChat: { reminderAfter: 10, closeAfterReminder: 10 },
  messaging: { reminderAfter: 30, closeAfterReminder: 15 },
};
/** A conversation the customer ended ("תודה", "bye") closes this long after its last message, quietly. */
export const MARKED_END_CLOSE_MINUTES = 10;
/** The customer's next message reopens a conversation the bot closed, inside this many days. */
export const BOT_CLOSE_REOPEN_DAYS = 7;

export type BotIdleLang = "he" | "en";
/** The default texts. Neutral in gender: nobody is "closing" in the feminine or the masculine. */
export const BOT_IDLE_DEFAULT_TEXTS: Record<BotIdleLang, { reminder: string; close: string }> = {
  he: { reminder: "עדיין כאן? אפשר להמשיך מכאן בכל רגע.", close: "סגרנו את השיחה בינתיים. אפשר לכתוב כאן שוב בכל רגע." },
  en: { reminder: "Still here? You can pick this up any time.", close: "We've closed this chat for now. You can write here again any time." },
};

/** The close's system event: { systemEvent: "auto_closed", reason }. */
export const BOT_IDLE_CLOSE_REASON = "bot_idle";
export const BOT_END_CLOSE_REASON = "customer_ended";
export const BOT_CLOSE_REASONS: readonly string[] = [BOT_IDLE_CLOSE_REASON, BOT_END_CLOSE_REASON];

/** metadata.source of the sweep's own two messages. */
export const BOT_IDLE_SOURCE = { reminder: "idle_reminder", close: "idle_close" } as const;

/** The reply engine's mark on its conversation state: the time of the turn whose customer message was an end. */
export const ENDED_FACT = "_endedAt";

/**
 * The one switch for the default and for the marked end. Unset or anything but an "on" word: only a
 * business with its own row runs, exactly as before. Read by incoming-worker (acts) and auth (shows it).
 */
export const BOT_IDLE_DEFAULT_ENV = "BOT_IDLE_DEFAULT_ON";
export const botIdleDefaultOn = (env: Record<string, string | undefined> = process.env): boolean =>
  /^(?:1|true|on|yes)$/i.test(String(env[BOT_IDLE_DEFAULT_ENV] ?? "").trim());

/** One group as the settings screen reads and writes it. */
export interface BotIdleGroupValues {
  enabled: boolean;
  reminderAfterMinutes: number;
  /** Counted from the reminder. */
  closeAfterReminderMinutes: number;
  reminderText: string;
  /** Empty: the conversation closes with no message. */
  closeText: string;
}
export interface BotIdleGroupView extends BotIdleGroupValues { source: "default" | "custom" }

/** What the sweep applies to one channel. */
export interface BotIdleRule {
  reminderEnabled: boolean;
  reminderDelayMinutes: number;
  reminderMessage: string;
  autoCloseEnabled: boolean;
  autoCloseDelayMinutes: number;
  autoCloseMessage: string;
  source: "default" | "custom";
}

interface FlatRow extends Omit<BotIdleRule, "source"> { channels: string[] }
interface StoredRow { flat: FlatRow | null; groups: Partial<Record<BotIdleGroup, BotIdleGroupValues>>; raw: Record<string, unknown> }

const minutes = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const text = (v: unknown) => (typeof v === "string" ? v : "");

function readGroup(v: unknown, group: BotIdleGroup): BotIdleGroupValues | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  if (typeof g.enabled !== "boolean") return null;
  const d = BOT_IDLE_DEFAULT_MINUTES[group];
  return {
    enabled: g.enabled,
    reminderAfterMinutes: minutes(g.reminderAfterMinutes, d.reminderAfter),
    closeAfterReminderMinutes: minutes(g.closeAfterReminderMinutes, d.closeAfterReminder),
    reminderText: text(g.reminderText),
    closeText: text(g.closeText),
  };
}

/** The row as stored. An unreadable row is no row. */
export function parseBotIdleRow(raw: string | null | undefined): StoredRow {
  const none: StoredRow = { flat: null, groups: {}, raw: {} };
  if (!raw) return none;
  let c: any;
  try { c = JSON.parse(raw); } catch { return none; }
  if (!c || typeof c !== "object" || Array.isArray(c)) return none;
  const hasFlat = typeof c.reminderEnabled === "boolean" || typeof c.autoCloseEnabled === "boolean";
  const flat: FlatRow | null = hasFlat
    ? {
        reminderEnabled: c.reminderEnabled === true,
        reminderDelayMinutes: minutes(c.reminderDelayMinutes, 10),
        reminderMessage: text(c.reminderMessage),
        autoCloseEnabled: c.autoCloseEnabled === true,
        autoCloseDelayMinutes: minutes(c.autoCloseDelayMinutes, 10),
        autoCloseMessage: text(c.autoCloseMessage),
        channels: Array.isArray(c.channels) && c.channels.length ? c.channels.map(String) : ["WEBCHAT"],
      }
    : null;
  const groups: StoredRow["groups"] = {};
  for (const g of BOT_IDLE_GROUPS) {
    const v = readGroup(c.groups?.[g], g);
    if (v) groups[g] = v;
  }
  return { flat, groups, raw: c };
}

const fromGroup = (g: BotIdleGroupValues): BotIdleRule => ({
  reminderEnabled: true,
  reminderDelayMinutes: g.reminderAfterMinutes,
  reminderMessage: g.reminderText,
  autoCloseEnabled: true,
  autoCloseDelayMinutes: g.closeAfterReminderMinutes,
  autoCloseMessage: g.closeText,
  source: "custom",
});

const defaultRule = (group: BotIdleGroup, lang: BotIdleLang = "en"): BotIdleRule => ({
  reminderEnabled: true,
  reminderDelayMinutes: BOT_IDLE_DEFAULT_MINUTES[group].reminderAfter,
  reminderMessage: BOT_IDLE_DEFAULT_TEXTS[lang].reminder,
  autoCloseEnabled: true,
  autoCloseDelayMinutes: BOT_IDLE_DEFAULT_MINUTES[group].closeAfterReminder,
  autoCloseMessage: BOT_IDLE_DEFAULT_TEXTS[lang].close,
  source: "default",
});

/**
 * The rule of one channel, or null when nothing runs there. In order: the channel's saved group; the flat
 * shape when it lists the channel; the default when it is switched on. A saved group that is off, or a
 * flat shape with both steps off, means off for its channels: the default does not step in.
 */
export function botIdleRuleFor(channel: string | null | undefined, row: StoredRow, defaultOn: boolean): BotIdleRule | null {
  const ch = String(channel ?? "");
  const group = botIdleGroupOf(ch);
  const saved = group ? row.groups[group] : undefined;
  if (saved) return saved.enabled ? fromGroup(saved) : null;
  if (row.flat && row.flat.channels.includes(ch)) {
    const { channels: _channels, ...steps } = row.flat;
    return steps.reminderEnabled || steps.autoCloseEnabled ? { ...steps, source: "custom" } : null;
  }
  return group && defaultOn ? defaultRule(group) : null;
}

/** Every channel with a rule, for one business. Empty: the sweep has nothing to do there. */
export function botIdleRules(row: StoredRow, defaultOn: boolean): Record<string, BotIdleRule> {
  const out: Record<string, BotIdleRule> = {};
  const channels = new Set<string>([...BOT_IDLE_CHANNELS, ...(row.flat?.channels ?? [])]);
  for (const ch of channels) {
    const rule = botIdleRuleFor(ch, row, defaultOn);
    if (rule) out[ch] = rule;
  }
  return out;
}

const DEFAULT_WORDINGS: Record<"reminder" | "close", string[]> = {
  reminder: [BOT_IDLE_DEFAULT_TEXTS.he.reminder, BOT_IDLE_DEFAULT_TEXTS.en.reminder],
  close: [BOT_IDLE_DEFAULT_TEXTS.he.close, BOT_IDLE_DEFAULT_TEXTS.en.close],
};

/**
 * The text of a step. The default wording follows the conversation's language, also once it was saved
 * unchanged from the settings screen (which shows it in the workspace's language); a text the business
 * wrote goes out as written.
 */
export function botIdleText(rule: BotIdleRule, step: "reminder" | "close", lang: BotIdleLang): string {
  const stored = (step === "reminder" ? rule.reminderMessage : rule.autoCloseMessage).trim();
  return stored && DEFAULT_WORDINGS[step].includes(stored) ? BOT_IDLE_DEFAULT_TEXTS[lang][step] : stored;
}

const HEBREW = /[֐-׿]/;
/** The conversation's language for a default text: the detected one, else the letters of its last message. */
export function botIdleLang(detectedLocale: string | null | undefined, lastBody: string | null | undefined): BotIdleLang {
  const d = String(detectedLocale ?? "").trim().toLowerCase();
  if (d) return d.startsWith("he") || d.startsWith("iw") ? "he" : "en";
  return HEBREW.test(String(lastBody ?? "")) ? "he" : "en";
}

/**
 * What the settings screen reads: each group's effective values and where they come from. A group the flat
 * shape touches (it lists one of the group's channels) reads as that shape, until the group is saved.
 */
export function botIdleView(row: StoredRow, defaultOn: boolean, lang: BotIdleLang): Record<BotIdleGroup, BotIdleGroupView> {
  const view = {} as Record<BotIdleGroup, BotIdleGroupView>;
  for (const group of BOT_IDLE_GROUPS) {
    const saved = row.groups[group];
    if (saved) { view[group] = { ...saved, source: "custom" }; continue; }
    const flat = row.flat && BOT_IDLE_GROUP_CHANNELS[group].some((ch) => row.flat!.channels.includes(ch)) ? row.flat : null;
    if (flat) {
      view[group] = {
        enabled: flat.reminderEnabled || flat.autoCloseEnabled,
        reminderAfterMinutes: flat.reminderDelayMinutes,
        closeAfterReminderMinutes: flat.autoCloseDelayMinutes,
        reminderText: flat.reminderMessage,
        closeText: flat.autoCloseMessage,
        source: "custom",
      };
      continue;
    }
    const d = defaultRule(group, lang);
    view[group] = {
      enabled: defaultOn,
      reminderAfterMinutes: d.reminderDelayMinutes,
      closeAfterReminderMinutes: d.autoCloseDelayMinutes,
      reminderText: d.reminderMessage,
      closeText: d.autoCloseMessage,
      source: "default",
    };
  }
  return view;
}

/** The row after a save of one group or both. Everything else in the row stays as it was. */
export function botIdleWithGroups(raw: string | null | undefined, groups: Partial<Record<BotIdleGroup, BotIdleGroupValues>>): string {
  const row = parseBotIdleRow(raw);
  const next: Partial<Record<BotIdleGroup, BotIdleGroupValues>> = { ...row.groups };
  for (const g of BOT_IDLE_GROUPS) if (groups[g]) next[g] = groups[g];
  return JSON.stringify({ ...row.raw, groups: next });
}

/**
 * The marked end's step (the engine marked the customer's last message as an end):
 *   "close": close now, quietly. "wait": the mark holds, nothing is done (not due yet, or long past due:
 *   no reminder either, the customer said goodbye). null: no valid mark, the usual rule decides.
 * The mark holds while no customer message is newer than it and the conversation's last message is that
 * customer message or the bot's own reply to it.
 */
export function markedEndStep(a: {
  endedAt: unknown;
  last: { direction: string; createdAt: Date | string; botOutbound: boolean; idleSource: boolean } | null | undefined;
  lastInboundAt: Date | string | null | undefined;
  lateMinutes: number;
  now?: number;
}): "close" | "wait" | null {
  const mark = typeof a.endedAt === "string" && a.endedAt ? Date.parse(a.endedAt) : NaN;
  if (!Number.isFinite(mark) || !a.last || !a.lastInboundAt) return null;
  if (new Date(a.lastInboundAt).getTime() > mark) return null;
  const ours = a.last.direction === "OUTBOUND" && a.last.botOutbound && !a.last.idleSource;
  if (a.last.direction !== "INBOUND" && !ours) return null;
  const quiet = ((a.now ?? Date.now()) - new Date(a.last.createdAt).getTime()) / 60000;
  return quiet >= MARKED_END_CLOSE_MINUTES && quiet < MARKED_END_CLOSE_MINUTES + a.lateMinutes ? "close" : "wait";
}

/** The close's system event and the conversation's closedAt are written together; a later close by a person moves closedAt. */
const CLOSE_EVENT_SLACK_MS = 2 * 60_000;

/**
 * Reopen a conversation the bot closed (idle, or a marked end), on the customer's next message. Never one
 * a person closed: its newest system event must be the bot's close, written with this close (a person's
 * later Resolve writes no event and moves closedAt). `maxDays`: only inside that many days of the close.
 */
export async function reopenBotClosed(
  db: any,
  a: { tenantId: string; conversationId: string; maxDays?: number | null; now?: number },
): Promise<boolean> {
  const conv = await db.conversation.findFirst({
    where: { id: a.conversationId, tenantId: a.tenantId, status: "CLOSED" },
    select: { id: true, closedAt: true },
  });
  if (!conv) return false;
  const closedAt = conv.closedAt ? new Date(conv.closedAt).getTime() : NaN;
  const now = a.now ?? Date.now();
  if (a.maxDays != null && !(now - closedAt <= a.maxDays * 24 * 60 * 60_000)) return false;
  const event = await db.message.findFirst({
    where: { tenantId: a.tenantId, conversationId: a.conversationId, messageType: "system" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true, createdAt: true },
  });
  const meta: any = event?.metadata ?? {};
  if (meta.systemEvent !== "auto_closed" || !BOT_CLOSE_REASONS.includes(String(meta.reason ?? ""))) return false;
  if (Number.isFinite(closedAt) && Math.abs(new Date(event.createdAt).getTime() - closedAt) > CLOSE_EVENT_SLACK_MS) return false;
  const r = await db.conversation.updateMany({
    where: { id: a.conversationId, tenantId: a.tenantId, status: "CLOSED" },
    data: { status: "OPEN", closedAt: null, reminderSentAt: null },
  });
  return r.count > 0;
}
