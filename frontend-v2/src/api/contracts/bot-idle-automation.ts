import { z } from 'zod';

/**
 * The AI employee's own follow-up and auto-close (Omer, 2026-11-19) -
 * `GET/PUT /api/agents/settings/bot-idle-automation`.
 *
 * ⚠ ASSUMED SHAPE (Supervisior, 2026-11-19), until Backend's per-group
 *   contract lands: the GET returns each group's EFFECTIVE values and whether
 *   they are the platform's default or the business's own; the PUT takes one
 *   group or both. Everything that knows the wire lives in this file - the
 *   read, the group keys, the write body - so the final contract is an edit
 *   here and nowhere else.
 *
 * The route live today stores one flat object (reminderEnabled, …, channels)
 * and refuses unknown keys. Against it this read finds no group, so the
 * drawer says it could not read them and writes nothing.
 *
 * No value is invented here: the defaults (10 + 10 minutes on live chat,
 * 30 + 15 on messaging, the two texts) are the server's, read from the GET.
 */

/** The two groups, in the order the drawer draws them. */
export const BOT_IDLE_GROUPS = ['liveChat', 'messaging'] as const;
export type BotIdleGroupKey = (typeof BOT_IDLE_GROUPS)[number];

/** The longest delay a group takes, in minutes - assumed the same seven days as the person-held setting. */
export const BOT_IDLE_DELAY_MAX_MINUTES = 10080;
/** The longest text, as the person-held setting. */
export const BOT_IDLE_TEXT_MAX = 1000;

/** One group as the drawer reads it. */
export interface BotIdleGroup {
  readonly enabled: boolean;
  readonly reminderAfterMinutes: number;
  /** Counted from the reminder. */
  readonly closeAfterReminderMinutes: number;
  readonly reminderText: string;
  /** Empty: the conversation closes without a message. */
  readonly closeText: string;
  /** `null` when the server sent neither word: no hint is drawn. */
  readonly source: 'default' | 'custom' | null;
}

/** What a save sends for one group: every field of it, never `source`. */
export type BotIdleGroupWrite = Omit<BotIdleGroup, 'source'>;

const minutes = z.number().int().min(1).max(BOT_IDLE_DELAY_MAX_MINUTES);
const text = z
  .string()
  .max(BOT_IDLE_TEXT_MAX)
  .nullable()
  .optional()
  .transform((v) => v ?? '');

/**
 * A group is read whole or not at all: a missing delay is never filled in
 * with a number of ours, so a group the server did not describe is unread.
 */
const groupSchema = z.looseObject({
  enabled: z.boolean(),
  reminderAfterMinutes: minutes,
  closeAfterReminderMinutes: minutes,
  reminderText: text,
  closeText: text,
  source: z
    .enum(['default', 'custom'])
    .nullable()
    .optional()
    .catch(null)
    .transform((v) => v ?? null),
});

/** The read: each group, or `null` for one the server did not describe. */
export type BotIdleGroups = Readonly<Record<BotIdleGroupKey, BotIdleGroup | null>>;

export const botIdleResponseSchema = z.unknown();

/** Each group on its own: one odd group is unread, never the other. */
export function botIdleGroupsOf(raw: unknown): BotIdleGroups {
  const body = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const one = (key: BotIdleGroupKey): BotIdleGroup | null => {
    const parsed = groupSchema.safeParse(body[key]);
    if (!parsed.success) return null;
    const g = parsed.data;
    return {
      enabled: g.enabled,
      reminderAfterMinutes: g.reminderAfterMinutes,
      closeAfterReminderMinutes: g.closeAfterReminderMinutes,
      reminderText: g.reminderText,
      closeText: g.closeText,
      source: g.source,
    };
  };
  return { liveChat: one('liveChat'), messaging: one('messaging') };
}

/** A whole number of minutes within what a group takes. */
export function botIdleMinutesOk(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= BOT_IDLE_DELAY_MAX_MINUTES;
}

/** Why a group could not be sent as it is; `null` when it can. */
export function botIdleGroupProblem(group: BotIdleGroupWrite): 'delay' | 'text' | null {
  if (!botIdleMinutesOk(group.reminderAfterMinutes)) return 'delay';
  if (!botIdleMinutesOk(group.closeAfterReminderMinutes)) return 'delay';
  if (group.reminderText.length > BOT_IDLE_TEXT_MAX) return 'text';
  if (group.closeText.length > BOT_IDLE_TEXT_MAX) return 'text';
  // A reminder that is on needs words, as the person-held setting: an empty one sends nothing.
  if (group.enabled && group.reminderText.trim() === '') return 'text';
  return null;
}

/** The PUT body: only the groups given, each whole, its texts trimmed. */
export function botIdleBody(
  groups: Partial<Record<BotIdleGroupKey, BotIdleGroupWrite>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of BOT_IDLE_GROUPS) {
    const g = groups[key];
    if (!g) continue;
    body[key] = {
      enabled: g.enabled,
      reminderAfterMinutes: g.reminderAfterMinutes,
      closeAfterReminderMinutes: g.closeAfterReminderMinutes,
      reminderText: g.reminderText.trim(),
      closeText: g.closeText.trim(),
    };
  }
  return body;
}
