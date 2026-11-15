'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { type PlatformSender, type SenderStatus } from '@/api/contracts/platform-whatsapp';
import { Button } from '@/design-system/primitives/button/Button';
import {
  StatusIndicator,
  type StatusTone,
} from '@/design-system/primitives/status/StatusIndicator';
import { UserText } from '@/design-system/primitives/text/UserText';
import { useRouter } from '@/i18n/navigation';

import { ConfirmedAction } from '../ConfirmedAction';
import consoleStyles from '../Console.module.css';
import { PlatformConnect } from './PlatformConnect';
import {
  disconnectPlatformNumber,
  recheckPlatformNumber,
  type PlatformWrite,
} from './platform-whatsapp-actions';
import styles from './PlatformWhatsApp.module.css';

const TONE: Record<SenderStatus, StatusTone> = {
  CONNECTED: 'done',
  PENDING_WEBHOOK: 'waiting',
  TOKEN_INVALID: 'waiting',
  DISCONNECTED: 'neutral',
  UNKNOWN: 'neutral',
};

const QUALITY = new Set(['GREEN', 'YELLOW', 'RED']);

/**
 * GOTCHA's alerts number: its state in words, the number itself, and what
 * can be done from here. Every state is said from `status`, never from the
 * English `lastError`.
 *
 *   DISCONNECTED     nothing sends: Connect
 *   CONNECTED        sends: Check with Meta, Disconnect, Retire
 *   PENDING_WEBHOOK  sends, replies may not arrive: the same, Check first
 *   TOKEN_INVALID    nothing sends: Connect again, said as a stop
 *   UNKNOWN          a state this build has no name for: Check with Meta
 */
export function PlatformNumber({ sender }: { readonly sender: PlatformSender }) {
  const t = useTranslations('console.platformWhatsApp');
  const format = useFormatter();
  const { status, number } = sender;
  const linked =
    status === 'CONNECTED' || status === 'PENDING_WEBHOOK' || status === 'TOKEN_INVALID';
  const shown = linked && number ? number : null;

  return (
    <section
      className={consoleStyles.card}
      aria-labelledby="platform-number"
      data-testid="platform-number"
    >
      <div className={styles.head}>
        <h2 id="platform-number" className={consoleStyles.cardTitle}>
          {t('facts.title')}
        </h2>
        <span data-testid="platform-status" data-status={status}>
          <StatusIndicator tone={TONE[status]}>{t(`badge.${status}`)}</StatusIndicator>
        </span>
      </div>

      {status === 'TOKEN_INVALID' ? (
        <div className={consoleStyles.notice} role="alert" data-testid="platform-stopped">
          <p className={consoleStyles.noticeTitle}>{t('stoppedTitle')}</p>
          <p className={styles.sentence}>{t('status.TOKEN_INVALID')}</p>
        </div>
      ) : status === 'PENDING_WEBHOOK' ? (
        <div className={consoleStyles.notice} data-testid="platform-status-sentence">
          <p className={styles.sentence}>{t('status.PENDING_WEBHOOK')}</p>
        </div>
      ) : (
        <p className={styles.sentence} data-testid="platform-status-sentence">
          {t(`status.${status}`)}
        </p>
      )}

      {sender.source === 'env' ? (
        <p className={styles.quiet} data-testid="platform-source-env">
          {t('source.env')}
        </p>
      ) : sender.source === 'db' && sender.envPresent ? (
        <p className={styles.quiet} data-testid="platform-source-db-over-env">
          {t('source.dbOverEnv')}
        </p>
      ) : null}

      {shown ? (
        <dl className={consoleStyles.facts} data-testid="platform-facts">
          <dt>{t('facts.number')}</dt>
          <dd className={consoleStyles.code}>
            {/* Isolated, not the cell: a dir="ltr" cell sits at the far edge in Hebrew. */}
            <bdi dir="ltr" data-testid="platform-display">
              {shown.display ?? shown.phoneNumberId}
            </bdi>
          </dd>
          {shown.verifiedName ? (
            <>
              <dt>{t('facts.name')}</dt>
              <dd>
                <UserText>{shown.verifiedName}</UserText>
              </dd>
            </>
          ) : null}
          {shown.qualityRating ? (
            <>
              <dt>{t('facts.quality')}</dt>
              <dd>
                {QUALITY.has(shown.qualityRating) ? (
                  t(`quality.${shown.qualityRating}`)
                ) : (
                  <bdi dir="ltr" className={consoleStyles.code}>
                    {shown.qualityRating}
                  </bdi>
                )}
              </dd>
            </>
          ) : null}
          {shown.messagingLimitTier ? (
            <>
              <dt>{t('facts.limit')}</dt>
              <dd className={consoleStyles.code}>
                <bdi dir="ltr">{shown.messagingLimitTier}</bdi>
              </dd>
            </>
          ) : null}
          {shown.wabaId ? (
            <>
              <dt>{t('facts.waba')}</dt>
              <dd className={consoleStyles.code}>
                <bdi dir="ltr">{shown.wabaId}</bdi>
              </dd>
            </>
          ) : null}
          {sender.connectedAt ? (
            <>
              <dt>{t('facts.connected')}</dt>
              <dd>
                {sender.connectedBy?.name
                  ? t('facts.by', {
                      date: format.dateTime(new Date(sender.connectedAt), { dateStyle: 'medium' }),
                      name: sender.connectedBy.name,
                    })
                  : format.dateTime(new Date(sender.connectedAt), { dateStyle: 'medium' })}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {status === 'DISCONNECTED' || (status === 'UNKNOWN' && !number) ? (
        <PlatformConnect launch={sender.launch} again={false} />
      ) : null}
      {status === 'TOKEN_INVALID' ? <PlatformConnect launch={sender.launch} again /> : null}

      {status !== 'DISCONNECTED' ? (
        <div className={styles.actions}>
          <Recheck />
          {linked ? <Unlink /> : null}
          {shown ? <Retire typed={shown.display ?? shown.phoneNumberId} /> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Meta read again. Writes only our row, so it is not asked first. */
function Recheck() {
  const t = useTranslations('console.platformWhatsApp');
  const router = useRouter();
  const [outcome, setOutcome] = useState<PlatformWrite | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <div className={consoleStyles.action}>
      <Button
        disabled={isPending}
        data-testid="platform-recheck"
        onClick={() => {
          setOutcome(null);
          startTransition(async () => {
            const done = await recheckPlatformNumber();
            setOutcome(done);
            if (done.ok) router.refresh();
          });
        }}
      >
        {t('recheck.action')}
      </Button>
      {outcome ? (
        <p
          className={outcome.ok ? consoleStyles.done : consoleStyles.refused}
          role={outcome.ok ? 'status' : 'alert'}
          data-testid="platform-recheck-outcome"
        >
          {outcome.ok ? t('recheck.done') : t(`refusal.${outcome.reason}`)}
        </p>
      ) : null}
    </div>
  );
}

/** Unlink: alerts stop; the number and its templates stay at Meta. */
function Unlink() {
  const t = useTranslations('console.platformWhatsApp');
  return (
    <ConfirmedAction<PlatformWrite>
      label={t('disconnect.action')}
      sentences={[t('disconnect.first'), t('disconnect.second')]}
      yes={t('disconnect.yes')}
      run={() => disconnectPlatformNumber(false)}
      done={() => t('disconnect.done')}
      refused={(result) => t(`refusal.${result.reason}`)}
      testid="platform-disconnect"
    />
  );
}

/** Retire: also off the Cloud API. Typed back before Yes. */
function Retire({ typed }: { readonly typed: string }) {
  const t = useTranslations('console.platformWhatsApp');
  return (
    <ConfirmedAction<PlatformWrite>
      label={t('retire.action')}
      sentences={[t('retire.first'), t('retire.second')]}
      yes={t('retire.yes')}
      match={{ label: t('retire.match'), value: typed }}
      run={() => disconnectPlatformNumber(true)}
      done={() => t('retire.done')}
      refused={(result) => t(`refusal.${result.reason}`)}
      variant="danger"
      testid="platform-retire"
    />
  );
}
