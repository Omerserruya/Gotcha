'use client';

import { useLocale, useTranslations } from 'next-intl';

import { humanizeTag, isKnownRiskTag, type Approval } from '@/api/contracts/approvals';
import type { RejectReason } from '@/features/approvals/ApprovalsScreen';
import { isolated } from '@/features/approvals/isolate';
import type { Words } from '@/features/approvals/request-words';

import { planAsked, spanOf, type RowClock } from './mobile-approvals';

/**
 * The words a request is said in on the phone - the desktop's own keys under
 * `approvals`, so a card and the website's row cannot say it differently.
 */
export function useApprovalWords({
  requesters,
  aiAsked,
  viewerId,
}: {
  /** `id → who asked`, resolved on the server. */
  readonly requesters: Readonly<Record<string, string>>;
  /** Requests an AI asked for whose employee cannot be named. */
  readonly aiAsked: readonly string[];
  readonly viewerId: string | null;
}) {
  const t = useTranslations('approvals');
  const locale = useLocale();

  const say = (words: Words | null, fallback: string) =>
    words
      ? t(`request.${words.key}` as 'request.queueRefund', isolated(words.values) as never)
      : fallback;

  const reasonText = (key: RejectReason) =>
    key === 'wrong'
      ? t('plan.reasons.wrong')
      : key === 'tooGenerous' || key === 'other'
        ? t(`reject3.${key}`)
        : t(`action2.reasons.${key}`);

  const riskLabel = (tag: string) =>
    isKnownRiskTag(tag) ? t(`risk.${tag}` as 'risk.IRREVERSIBLE') : humanizeTag(tag);

  /** "09:39", or nothing for a date that does not parse. */
  const clock = (iso: string): string | null => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  };

  const span = (ms: number) => {
    const { unit, n } = spanOf(ms);
    return t(`time.${unit}`, { n });
  };

  /** A card's time: lapsed, "38m left", or how long it has waited. */
  const timeText = (time: RowClock) =>
    time.kind === 'lapsed'
      ? t('queue.lapsed')
      : time.kind === 'left'
        ? t('time.left', { in: span(time.ms) })
        : span(time.ms);

  /** Who asked, and with `at` when: the desktop detail's eyebrow. */
  const askedBy = (approval: Approval, at = false): string => {
    const time = at ? clock(approval.createdAt) : null;
    const plan = planAsked(approval, viewerId);
    if (plan) {
      const asked = t(plan.key as 'plan.asked.you.unknown', { name: plan.name ?? '' });
      return time ? `${asked} · ${time}` : asked;
    }
    const who = requesters[approval.id];
    if (who) return time ? t('detail2.eyebrow', { who, time }) : t('detail.requestedBy', { who });
    if (aiAsked.includes(approval.id)) {
      return t('detail3.eyebrowAi', { time: clock(approval.createdAt) ?? '' });
    }
    return time ? t('detail2.eyebrowAutomation', { time }) : t('detail.requestedByAutomation');
  };

  return { t, locale, say, reasonText, riskLabel, clock, timeText, askedBy };
}
