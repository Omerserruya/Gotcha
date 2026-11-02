import type { Campaign } from '@/api/contracts/outreach';

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
