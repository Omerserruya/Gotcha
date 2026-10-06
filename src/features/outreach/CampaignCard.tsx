import { getFormatter, getTranslations } from 'next-intl/server';

import { isInFlight, isStoppable, type Campaign } from '@/api/contracts/outreach';
import { channelName } from '@/api/contracts/inbox';

import { Link } from '@/i18n/navigation';

import styles from './Outreach.module.css';
import { SendCampaign } from './SendButtons';
import { StopCampaign } from './StopCampaign';
import { campaignWhen } from './when';

/**
 * One campaign, on screen 05 and again as the result card on 05b.
 *
 * ── TWO NUMBERS, NOT FIVE, AND THIS COMMENT SAID FIVE ──
 * It read: *"Sent, delivered, opened, replied - **all four genuinely
 * written** - and failed."*
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
 * has ever run, and its guard was `> 0`, so it never rendered at all - **a
 * branch that cannot be entered looks exactly like one that is simply
 * rare.** It comes back when the aggregate does.
 */
export async function CampaignCard({
  campaign,
  detailed,
  waba = null,
}: {
  readonly campaign: Campaign;
  /** 05b shows the rates; 05's in-flight list shows the headline only. */
  readonly detailed: boolean;
  /** A real WhatsApp Business account is connected; `null` when unread. */
  readonly waba?: boolean | null;
}) {
  const t = await getTranslations('outreach');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();

  const channel = channelName(campaign.channel, channelNames);
  const audience = campaign.audience;
  const audienceLine =
    audience.kind === 'everyone'
      ? audience.channel && channelName(audience.channel, channelNames)
        ? t('detail.audience.everyoneOn', {
            channel: channelName(audience.channel, channelNames)!,
          })
        : t('detail.audience.everyone')
      : audience.kind === 'picked'
        ? t('detail.audience.picked', { count: audience.count })
        : t(`detail.audience.${audience.kind}`);
  const now = new Date();
  const at = (iso: string | null) => campaignWhen(iso, now, format);
  /*
   * ONE sentence for when - "Sending since Wednesday 14:18" - not the status
   * and then the sentence, which said "Sending" twice. The bare status only
   * where there is no moment to state.
   */
  const when =
    campaign.status === 'SCHEDULED' && at(campaign.scheduledAt)
      ? t('list.scheduledFor', { when: at(campaign.scheduledAt)! })
      : at(campaign.completedAt)
        ? t('list.finishedOn', { when: at(campaign.completedAt)! })
        : at(campaign.startedAt)
          ? t('list.startedOn', { when: at(campaign.startedAt)! })
          : t(`status.${campaign.status}` as 'status.SENDING');

  /*
    ════════════════════════════════════════════════════════════════════════
    ★★ 05's RIGHT-HAND COLUMN - the selected campaign as its fields
    ════════════════════════════════════════════════════════════════════════
    Measured: an eyebrow at 9px/500 in capitals, then Who · Where · When ·
    Delivery, each an 11.5px label over 13px text, `#EDE9E1` above every
    field but the first. 02's "What they get" and "Replies" need the message
    and a reply owner, which the list does not carry; they are not drawn.
  */
  return (
    <article
      className={styles.detail}
      data-testid={`campaign-${campaign.id}`}
      data-status={campaign.status}
    >
      <p className={styles.detailEyebrow}>{t('detail.eyebrow', { name: campaign.name })}</p>

      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt>{t('detail.who')}</dt>
          {/* 02's two lines: who they are (13px), then how many (11.5, green). */}
          <dd data-testid="campaign-who">
            <span className={styles.fieldLine}>{audienceLine}</span>
            <span className={styles.fieldStrong}>
              {t('list.people', { count: campaign.totalRecipients })}
            </span>
          </dd>
        </div>
        {channel ? (
          <div className={styles.field}>
            <dt>{t('detail.where')}</dt>
            <dd>{channel}</dd>
          </div>
        ) : null}
        <div className={styles.field}>
          <dt>{t('detail.when')}</dt>
          <dd data-testid={`when-${campaign.id}`}>{when}</dd>
        </div>
        <div className={styles.field}>
          <dt>{t('detail.delivery')}</dt>
          <dd>
            <span className={styles.counters}>
              <span data-testid={`sent-${campaign.id}`}>
                {t('counter.sent')} {format.number(campaign.sentCount)}
              </span>
              {/*
                Always shown, including when zero - "nothing failed" is a fact
                worth stating on a screen about messages reaching people.
              */}
              <span data-testid={`failed-${campaign.id}`}>
                {t('counter.failed')} {format.number(campaign.failedCount)}
              </span>
            </span>
            {/*
              ★★ THREE COUNTERS WERE HERE AND ALL THREE WERE ALWAYS ZERO.
              `deliveredCount`, `readCount` and `repliedCount` are initialised
              to zero and nothing in the monorepo increments them. Two
              different facts, one line each, with the reason as the tooltip:
              delivered and opened are COMING (the receipts exist, they are not
              counted against a campaign); replied is ABSENT (no inbound path
              carries a broadcast id).
            */}
            {detailed ? (
              <>
                <span
                  className={styles.counterAbsent}
                  data-testid={`pending-${campaign.id}`}
                  title={t('counter.deliveredPending')}
                >
                  {t('detail.deliveredShort')}
                </span>
                <span
                  className={styles.counterAbsent}
                  data-testid={`no-replies-${campaign.id}`}
                  title={t('counter.repliedAbsent')}
                >
                  {t('detail.repliedShort')}
                </span>
              </>
            ) : null}
          </dd>
        </div>
      </dl>

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

      {isStoppable(campaign) ? <StopCampaign id={campaign.id} name={campaign.name} /> : null}

      {/*
        A draft's Send (Omer): a WhatsApp campaign only through a real WhatsApp
        Business account; any other channel needs none. It asks before it sends.
      */}
      {detailed && campaign.status === 'DRAFT' ? (
        campaign.channel !== 'WHATSAPP' || waba === true ? (
          <SendCampaign id={campaign.id} count={campaign.totalRecipients} />
        ) : (
          <span
            className={styles.goDrawn}
            aria-disabled="true"
            title={waba === null ? t('go.send.unknown') : t('go.send.needsWaba')}
            data-testid={`send-drawn-${campaign.id}`}
          >
            {t('go.send.label')}
          </span>
        )
      ) : null}

      {/* 05b: once it has gone out, what it did is a page of its own. */}
      {detailed && !isInFlight(campaign) && campaign.status !== 'DRAFT' ? (
        <Link
          href={`/outreach/campaigns/${campaign.id}`}
          className={styles.cardResults}
          data-testid={`results-${campaign.id}`}
        >
          {t('results.seeResults')}
        </Link>
      ) : null}
    </article>
  );
}
