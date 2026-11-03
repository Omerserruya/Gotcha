import type { Campaign } from '@/api/contracts/outreach';
import { dialable } from '@/features/calls/dial';

/**
 * A campaign as the phone says it - the desktop card's sentences, chosen
 * the way `CampaignCard` chooses them, as keys under `outreach` so the
 * wording stays in the catalogue.
 */

/**
 * ONE sentence for when, as the desktop card: "Scheduled for…", "Finished…",
 * "Sending since…" - the bare status only where there is no moment to state.
 * `at` formats a moment, or answers `null` for one it cannot read.
 */
export function whenWords(
  campaign: Pick<Campaign, 'status' | 'scheduledAt' | 'completedAt' | 'startedAt'>,
  at: (iso: string | null) => string | null,
): { readonly key: string; readonly when?: string } {
  const scheduled = at(campaign.scheduledAt);
  if (campaign.status === 'SCHEDULED' && scheduled)
    return { key: 'list.scheduledFor', when: scheduled };
  const finished = at(campaign.completedAt);
  if (finished) return { key: 'list.finishedOn', when: finished };
  const started = at(campaign.startedAt);
  if (started) return { key: 'list.startedOn', when: started };
  return { key: `status.${campaign.status}` };
}

/** Who it was for, as `outreach.detail.audience.*` and its values - never a rule in words. */
export function audienceWords(
  audience: Campaign['audience'],
  channelOf: (channel: string) => string | null,
): { readonly key: string; readonly values?: Record<string, string | number> } {
  if (audience.kind === 'everyone') {
    const channel = audience.channel ? channelOf(audience.channel) : null;
    return channel
      ? { key: 'detail.audience.everyoneOn', values: { channel } }
      : { key: 'detail.audience.everyone' };
  }
  if (audience.kind === 'picked')
    return { key: 'detail.audience.picked', values: { count: audience.count } };
  return { key: `detail.audience.${audience.kind}` };
}

/** How far a campaign got, of whom it was meant for: `null` with nobody to send to. */
export function sentShare(
  campaign: Pick<Campaign, 'sentCount' | 'totalRecipients'>,
): number | null {
  return campaign.totalRecipients > 0
    ? Math.min(1, campaign.sentCount / campaign.totalRecipients)
    : null;
}

/**
 * The phone's chips: running, scheduled, finished. A draft is in "all" only.
 *
 * ★ NO "WAITING FOR YOU". The design's fourth chip is a campaign held for
 *   approval, and `Broadcast` carries no approval field: a chip that always
 *   counts zero would be a control that does nothing.
 */
export const CAMPAIGN_GROUPS = ['live', 'sched', 'done'] as const;
export type CampaignGroup = (typeof CAMPAIGN_GROUPS)[number];

export function groupOf(status: Campaign['status']): CampaignGroup | null {
  if (status === 'SENDING') return 'live';
  if (status === 'SCHEDULED') return 'sched';
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return 'done';
  return null;
}

/** `?show=` as a group, or `null` for everything - an unknown value is everything. */
export function parseGroup(raw: string | undefined): CampaignGroup | null {
  return (CAMPAIGN_GROUPS as readonly string[]).includes(raw ?? '') ? (raw as CampaignGroup) : null;
}

/** The status tag's tone: sending is good news, a halt is bad, the rest is quiet. */
export function statusTone(status: Campaign['status']): 'ok' | 'bad' | 'mute' {
  if (status === 'SENDING') return 'ok';
  if (status === 'FAILED') return 'bad';
  return 'mute';
}

/* ── "New outreach": one person, a message or a call (2026-11-03) ─────────── */

/** Channels whose handle IS a phone number, so a call can be placed to it. */
const PHONE_KEYED = new Set(['WHATSAPP', 'VOICE', 'SMS']);

/**
 * The number a call to this contact goes to, as the line dials it (E.164):
 * the stored phone, else a phone-keyed channel's own handle. `null` when
 * there is none - never a guess at a local number's country.
 */
export function callableNumber(row: {
  readonly phone: string | null;
  readonly channel: string;
  readonly externalId: string;
}): string | null {
  return (
    dialable(row.phone) ??
    (PHONE_KEYED.has(row.channel.toUpperCase()) ? dialable(row.externalId) : null)
  );
}

/** Longest search sent from the picker: a name, a number or an email, not a paragraph. */
export const PICK_QUERY_MAX = 80;
/** People the picker lists for one search; a narrower search finds the rest. */
export const PICK_SHOWN = 20;

/** The picker's search as it is sent: trimmed and capped; empty asks for nothing. */
export function pickQuery(raw: string): string {
  return raw.trim().slice(0, PICK_QUERY_MAX);
}

/**
 * What a call's outcome is said as, from `startCall`'s answer: the key under
 * `calls.dialer`. AGENT_FIRST rings the line's agent first; IN_PLATFORM dials
 * from a browser phone the app does not have, so nothing was dialled; a
 * refusal is the server's own reason when we have words for it.
 */
export function callOutcomeKey(
  result:
    | { readonly ok: true; readonly mode: 'AGENT_FIRST' | 'IN_PLATFORM' }
    | { readonly ok: false; readonly reason: string },
  known: (key: string) => boolean,
): string {
  if (result.ok) return result.mode === 'AGENT_FIRST' ? 'ringing' : 'inPlatform';
  return known(`error.${result.reason}`) ? `error.${result.reason}` : 'error.failed';
}
