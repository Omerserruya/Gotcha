import { getFormatter, getTranslations } from 'next-intl/server';

import { isStoppable, type Campaign } from '@/api/contracts/outreach';
import { channelName } from '@/api/contracts/inbox';

import styles from './Outreach.module.css';
import { StopCampaign } from './StopCampaign';

/**
 * One campaign, on screen 05 and again as the result card on 05b.
 *
 * ── TWO NUMBERS, NOT FIVE, AND THIS COMMENT SAID FIVE ──
 * It read: *"Sent, delivered, opened, replied — **all four genuinely
 * written** — and failed."*
 *
 * ★★ THREE OF THOSE FOUR ARE NEVER WRITTEN. `deliveredCount`, `readCount`
 * and `repliedCount` are initialised to zero and nothing in the monorepo
 * increments them; `broadcast.worker.ts:209` touches `sentCount` and
 * `failedCount` and nothing else.
 *
 * So the sentence asserting the numbers were real is what a reviewer read
 * instead of checking, and it sat directly above three counters rendering
 * zeroes. The same shape as `outcomeOf`'s comment two screens ago: **the
 * prose and the code disagreed and the prose was more persuasive.**
 *
 * `failed` stays, and the reason it was added stands: a card showing only
 * successes is the same screen that showed twenty-seven approvals as
 * "Approved" when thirteen of them never ran.
 *
 * `converted` is absent because it is not a concept anywhere in this platform.
 * So *"41 bought"*, *"63 people bought"* and the `Bought · 5%` row are gone,
 * along with attributed revenue, the stock projection, the per-campaign
 * opt-out counter, the hourly reply chart and the reply categories.
 *
 * ── AND THE LINE THE DESIGN DID NOT ASK FOR IS GONE WITH THEM ──
 * *"opened it and said nothing"* was `readCount − repliedCount`, described
 * here as "two numbers that exist". It was `0 − 0` for every campaign that
 * has ever run, and its guard was `> 0`, so it never rendered at all — **a
 * branch that cannot be entered looks exactly like one that is simply
 * rare.** It comes back when the aggregate does.
 */
export async function CampaignCard({
  campaign,
  detailed,
}: {
  readonly campaign: Campaign;
  /** 05b shows the rates; 05's in-flight list shows the headline only. */
  readonly detailed: boolean;
}) {
  const t = await getTranslations('outreach');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();

  return (
    <article
      className={styles.card}
      data-testid={`campaign-${campaign.id}`}
      data-status={campaign.status}
    >
      <header className={styles.cardHead}>
        <h3 className={styles.cardName}>{campaign.name}</h3>
        <p className={styles.cardMeta}>
          {t(`status.${campaign.status}` as 'status.SENDING')}
          {/* The sixth renderer: this appended the raw enum after the status. */}
          {channelName(campaign.channel, channelNames)
            ? ` · ${channelName(campaign.channel, channelNames)}`
            : null}
        </p>
      </header>

      {/*
        Why it stopped, where the platform knows. The model's own comment
        calls this "the last error when a broadcast halted", so a halted
        campaign says why instead of merely being halted.
      */}
      {campaign.lastError ? (
        <p className={styles.cardError} data-testid={`error-${campaign.id}`}>
          {t('card.halted', { reason: campaign.lastError })}
        </p>
      ) : null}

      <dl className={styles.counters}>
        <div className={styles.counter} data-testid={`sent-${campaign.id}`}>
          <dt>{t('counter.sent')}</dt>
          <dd>{format.number(campaign.sentCount)}</dd>
        </div>

        {/*
          ══════════════════════════════════════════════════════════════════
          ★★ THREE COUNTERS WERE HERE AND ALL THREE WERE ALWAYS ZERO
          ══════════════════════════════════════════════════════════════════
          `deliveredCount`, `readCount` and `repliedCount` are initialised to
          zero and **nothing in the monorepo ever increments them.** The only
          write is `broadcast.worker.ts:209`, and it touches `sentCount` and
          `failedCount` only.

          So a merchant whose campaign was delivered and read saw
          **"0 delivered · 0 opened · 0 replied"** — three measurements
          presented as findings, none of them taken. The calm wrong value at
          its purest: not a crash, not a blank, three plausible numbers.

          It shipped through a capture because this tenant has no broadcasts,
          so the card has never rendered with a campaign behind it. The
          screen was accepted on an empty state.

          ── AND THE DATA EXISTS, WHICH IS WHY THIS IS TWO SENTENCES ──
          `Message.broadcastId` is indexed and `Message.status` IS updated
          from delivery receipts — this tenant has READ 139 · DELIVERED 8.
          So delivered and opened are a `groupBy` away and are coming; that
          read is Backend's, not something to compose here.

          `replied` is not. No inbound path carries a broadcast id and
          `repliedAt` is never written, so it is absent rather than pending.
          Two different facts, two different sentences — the 14d rule.
        */}
        {detailed ? (
          <>
            <p className={styles.counterAbsent} data-testid={`pending-${campaign.id}`}>
              {t('counter.deliveredPending')}
            </p>
            <p className={styles.counterAbsent} data-testid={`no-replies-${campaign.id}`}>
              {t('counter.repliedAbsent')}
            </p>
          </>
        ) : null}

        {/*
          Always shown, including when zero — "nothing failed" is a fact worth
          stating on a screen about messages reaching people, and hiding it at
          zero would make its appearance a surprise rather than a reading.
        */}
        <div className={styles.counter} data-testid={`failed-${campaign.id}`}>
          <dt>{t('counter.failed')}</dt>
          <dd>{format.number(campaign.failedCount)}</dd>
        </div>
      </dl>

      {/*
        ★ "Opened and said nothing" was here, computed from
        `readCount - repliedCount` — two counters nothing ever increments.

        It never rendered a wrong number, because the guard was `silent > 0`
        and the subtraction was always 0 - 0. So it was unreachable rather
        than lying, which is why it survived a capture and a review: **a
        branch that cannot be entered looks exactly like a branch that is
        simply rare.**

        The line was genuinely good and it comes back when the aggregate
        does. It is removed rather than left dormant because its screen, 05b,
        is cancelled and a dormant branch is indistinguishable from a planned
        one.
      */}

      {isStoppable(campaign) ? <StopCampaign id={campaign.id} name={campaign.name} /> : null}
    </article>
  );
}
