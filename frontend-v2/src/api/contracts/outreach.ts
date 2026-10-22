import { z } from 'zod';

/**
 * Outreach - screens 05 and 05b.
 *
 * Shapes read from `services/conversation/src/routes/broadcasts.ts` and the
 * `Broadcast` model.
 *
 * ── THERE IS NO PAUSE, AND THAT IS THE SCREEN'S MOST IMPORTANT FACT ──
 * The design puts *"Pause the rest"* on a running campaign. `BroadcastStatus`
 * is `DRAFT | SCHEDULED | SENDING | COMPLETED | FAILED | CANCELLED` - **no
 * PAUSED** - and the routes are send, validate, cancel, resend. No pause, no
 * resume.
 *
 * `cancel` is terminal and destructive. It removes the queued jobs, marks
 * every pending recipient `"skipped"` with the reason *"Broadcast cancelled"*,
 * and sets `completedAt`. **There is no path back to SENDING.**
 *
 * So the control says *stop*, never *pause*. "Pause" implies two things - it
 * halts, and it resumes - and only the first is true. The second is the half
 * someone relies on when they hold a campaign for ten minutes.
 *
 * **An absent control leaves a visible gap. A control that exists and does
 * something adjacent and irreversible is how the label gets trusted.** Every
 * other dead control removed on this project was the first kind. This is the
 * first of the second kind.
 *
 * ── WHAT IS NOT MODELLED, AND WHY ──
 * `converted` is not a concept anywhere in this platform, so *"41 bought"*,
 * *"63 people bought"* and the `Bought · 5%` row have no field to read.
 * Attributed revenue has no inputs at all - its third appearance across three
 * screens. There is no per-campaign opt-out counter, no reply classification,
 * no stock projection, no approval field on `Broadcast`, and **no fallback
 * channel**: one `channel`, one `channelAccountId`, so *"WhatsApp, falls back
 * to email after 24h"* is unbacked in both places it is drawn.
 */

export const BROADCAST_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'SENDING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/**
 * One campaign.
 *
 * `object`, not `looseObject`. The row carries `audience` and `variables` -
 * arbitrary JSON, the first of which describes who is being messaged and is
 * not needed to render a card - plus `channelAccountId`, `flowId` and
 * `createdBy`. None crosses into the UI.
 */
export const campaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  channel: z.string().default(''),
  status: z.enum(BROADCAST_STATUSES).catch('DRAFT'),
  scheduledAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  createdAt: z.string(),

  totalRecipients: z.number().default(0),
  sentCount: z.number().default(0),
  deliveredCount: z.number().default(0),
  /** The platform's name for "opened". Read receipts, not opens of an email. */
  readCount: z.number().default(0),
  repliedCount: z.number().default(0),
  /**
   * The counter the design never asked for.
   *
   * Screen 03's lesson: a card showing only successes is the same screen that
   * showed 27 approvals as "Approved" when 13 of them never ran.
   */
  failedCount: z.number().default(0),
  /**
   * Why a campaign halted. The model's own comment: *"Last error message when
   * broadcast halted (channel API failure, billing issue, etc.)"* - so a
   * stopped campaign can say why instead of just being stopped.
   */
  lastError: z.string().nullable().default(null),
  /**
   * Who it was meant for - `Broadcast.audience`, a Json column, turned into
   * its DESCRIPTION here and never kept raw: the raw value carries contact
   * ids and CRM snapshots (names, phones, emails) that no card needs. Read
   * as `unknown` so a shape nobody foresaw is "a saved audience", never a
   * rejected campaign.
   */
  audience: z
    .unknown()
    .optional()
    .transform((raw) => describeAudience(raw)),
});

export type Campaign = z.infer<typeof campaignSchema>;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 02's "WHO" LINE, SAID ONLY WHERE IT CAN BE SAID PRECISELY
 * ════════════════════════════════════════════════════════════════════════════
 * The vocabulary, from the write sites: every write goes through the
 * broadcasts route's `parseAudience` (the AI's `create_broadcast` posts to
 * the same route; a resend copies the value verbatim), which keeps four forms
 * - `manual`, `filter`, `saved`, `composite` - or `null`, when recipients
 * were added to the campaign directly (the builder's import mode).
 *
 * ★ NO RULE IS PUT INTO WORDS. Filter fields are CRM property names,
 * arbitrary per tenant, and the one local field worth naming does not do what
 * its name says: `Contact.tags` is a Json column and the resolver filters it
 * as a scalar (`equals` compares the whole value; `contains` and `in` are not
 * Json filters). "Everyone tagged VIP" would describe a selection the
 * platform does not make. Any rule makes the audience "a saved audience".
 *
 * Measured on dev: one broadcast in the table, its audience a hand-written
 * `{"note":"ui test"}` with no `type` - the unrecognised form.
 */
export type AudienceWords =
  | { readonly kind: 'direct' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'everyone'; readonly channel: string | null }
  /** Hand-picked only: local contacts and CRM chips. */
  | { readonly kind: 'picked'; readonly count: number };

function hasRules(rules: unknown): boolean {
  if (!rules || typeof rules !== 'object') return false;
  const { all, any } = rules as { all?: unknown; any?: unknown };
  return [all, any].some((group) => Array.isArray(group) && group.length > 0);
}

export function describeAudience(audience: unknown): AudienceWords {
  if (audience === null || audience === undefined) return { kind: 'direct' };
  const a = audience as Record<string, unknown>;
  const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);

  if (a.type === 'composite' && a.everyone === true) {
    // Every contact (in the channel): picks and rules beside it add nobody.
    return { kind: 'everyone', channel: typeof a.channel === 'string' ? a.channel : null };
  }
  if ((a.type === 'manual' || a.type === 'composite') && !hasRules(a.rules)) {
    const picked = count(a.contactIds) + count(a.crmContacts);
    if (picked > 0) return { kind: 'picked', count: picked };
  }
  // `saved`, `filter`, anything with a rule, and any form the writers do not produce.
  return { kind: 'saved' };
}

export const campaignsSchema = z.array(campaignSchema);

/**
 * Can this campaign still be stopped?
 *
 * The route accepts `SENDING` and `SCHEDULED` only and answers 400 otherwise,
 * so anything else must not offer the control.
 */
export function isStoppable(campaign: Campaign): boolean {
  return campaign.status === 'SENDING' || campaign.status === 'SCHEDULED';
}

/*
 * ★★ `openedWithoutReplying` WAS HERE, AND IT SUBTRACTED TWO ZEROES.
 *
 * It computed `readCount - repliedCount` and its comment called them "two
 * numbers that genuinely exist" and "the best line on screen 05b".
 *
 * Neither counter is ever incremented - the only write in the monorepo is
 * `broadcast.worker.ts:209`, on `sentCount` and `failedCount`. So the
 * function returned 0 for every campaign that has ever existed and described
 * it as a segment somebody could act on.
 *
 * Its only caller was its own test, whose fixture used `readCount: 904,
 * repliedCount: 188` - values the platform cannot produce. **A test that
 * asserts arithmetic on data the system never emits passes forever and says
 * nothing about the product.**
 *
 * And screen 05b, which it existed for, is cancelled. Removed rather than
 * left as a plan for something that is not going to happen.
 */

/**
 * A share of what was actually sent.
 *
 * Denominated on `sentCount`, not `totalRecipients`: nobody can be delivered
 * to, read by or replied to among people the campaign never sent to, and
 * dividing by the intended audience would understate every rate on a campaign
 * that is still sending.
 *
 * `null` rather than zero when nothing has been sent - 0% and "not yet" are
 * different facts, and a run of 0% on a campaign that has not started is the
 * kind of number somebody screenshots.
 */
export function shareOfSent(count: number, campaign: Campaign): number | null {
  return campaign.sentCount > 0 ? count / campaign.sentCount : null;
}

/** Campaigns still doing something, in the order the screen shows them. */
export const IN_FLIGHT_STATUSES: readonly BroadcastStatus[] = ['SENDING', 'SCHEDULED'];

export function isInFlight(campaign: Campaign): boolean {
  return IN_FLIGHT_STATUSES.includes(campaign.status);
}
