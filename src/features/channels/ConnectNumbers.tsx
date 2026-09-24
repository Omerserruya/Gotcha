'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  explainsCoexistence,
  isConnectable,
  needsPin,
  type BusinessAppOptions,
  type Candidate,
  type InspectResponse,
} from '@/api/contracts/whatsapp-connect';
import { Button } from '@/design-system/primitives/button/Button';

import { connectNumber } from './whatsapp-actions';
import styles from './Channels.module.css';

/**
 * Choosing a number to connect — screens 13c and 13d.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ONE LIST, BECAUSE THE PLATFORM HAS NO DOORS
 * ════════════════════════════════════════════════════════════════════════════
 * 13c asks the merchant where their number lives — new install, or existing
 * WhatsApp Business app. `selectFlow` takes no customer-supplied choice, and
 * the `path` that `POST /inspect` stores on the session is never read back.
 *
 * So the two doors are inert: pick either and the same decision comes back.
 * A control that decides nothing is worse than an absent one, because the
 * person believes they chose. The detection has already happened; this screen
 * shows what was found and what each one would mean.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ NOTHING HERE FIRES ON ITS OWN
 * ════════════════════════════════════════════════════════════════════════════
 * `connectNumber` calls `subscribeApp` and `register` against a real Meta
 * business account and creates a `WhatsAppNumber` and a `ChannelAccount`. It
 * runs when a person presses the button, and in no test, capture or
 * automated run of any kind.
 */
export function ConnectNumbers({
  inspection,
  coexistence,
}: {
  readonly inspection: InspectResponse;
  /** Platform-authored copy for the Business app case. Rendered verbatim. */
  readonly coexistence: BusinessAppOptions | null;
}) {
  const t = useTranslations('channels.whatsapp');
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  function connect(phoneNumberId: string) {
    setFailure(null);
    startTransition(async () => {
      const result = await connectNumber(inspection.sessionId, phoneNumberId);
      if (!result.ok) setFailure(result.message);
    });
  }

  if (inspection.candidates.length === 0) {
    return (
      <p className={styles.empty} data-testid="connect-none">
        {t('connect.none')}
      </p>
    );
  }

  return (
    <section className={styles.connect} data-testid="connect">
      <h2 className={styles.sectionHeading}>{t('connect.heading')}</h2>
      <p className={styles.deliveryDetail}>{t('connect.intro')}</p>

      <ul className={styles.numbers}>
        {inspection.candidates.map((candidate) => (
          <li key={candidate.phoneNumberId}>
            <CandidateCard
              candidate={candidate}
              coexistence={coexistence}
              t={t}
              disabled={isPending}
              onConnect={() => connect(candidate.phoneNumberId)}
            />
          </li>
        ))}
      </ul>

      {failure ? (
        <p className={styles.templatesPausedReason} data-testid="connect-failed">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

function CandidateCard({
  candidate,
  coexistence,
  t,
  disabled,
  onConnect,
}: {
  readonly candidate: Candidate;
  readonly coexistence: BusinessAppOptions | null;
  readonly t: ReturnType<typeof useTranslations<'channels.whatsapp'>>;
  readonly disabled: boolean;
  readonly onConnect: () => void;
}) {
  const connectable = isConnectable(candidate);

  return (
    <article
      className={styles.number}
      data-testid="connect-candidate"
      data-scenario={candidate.scenario}
    >
      <p className={styles.numberLine}>
        <span className={styles.numberPhone}>
          {candidate.phoneNumber ?? candidate.phoneNumberId}
        </span>
        {candidate.name ? <span className={styles.numberName}>{candidate.name}</span> : null}
        <span className={styles.templatesBadge} data-testid="connect-scenario">
          {t(`connect.scenario.${candidate.scenario}`)}
        </span>
      </p>

      {/*
        The platform's sentence for this row — "the text the connect screen
        shows, so it says what will happen rather than what we detected".
        Six of our own would compete with six authored for this screen and
        drift the first time a scenario changed meaning.
      */}
      {candidate.message ? (
        <p className={styles.deliveryDetail} data-testid="connect-message">
          {candidate.message}
        </p>
      ) : null}

      {candidate.alreadyConnectedHere ? (
        <p className={styles.deliveryDetail} data-testid="connect-already">
          {t('connect.alreadyHere')}
        </p>
      ) : null}

      {/*
        ★ THE PIN, BEFORE THE CLICK.
        `customerAction` is on the candidate, so this is known without
        submitting anything. Saying it afterwards would be telling somebody
        they need a code they do not have, halfway through.
      */}
      {needsPin(candidate) ? (
        <p className={styles.fixHere} data-testid="connect-pin">
          {t('connect.pinWarning')}
        </p>
      ) : null}

      {/*
        BLOCKED: present, named, unselectable. "Not you, not now" — the
        blockers say what to clear.
      */}
      {!connectable ? (
        <section className={styles.theirs} data-testid="connect-blocked">
          <h3 className={styles.checkHeading}>{t('connect.blockedHeading')}</h3>
          <ul className={styles.checks}>
            {candidate.blockers.map((blocker) => (
              <li key={blocker} className={styles.checkDetail} data-testid="connect-blocker">
                {blocker}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        ★ COEXISTENCE: ONE OPTION AND A PARAGRAPH, NOT TWO OPTIONS.

        `fullMigration.available` is typed as the literal `false` — for every
        Business app number that will ever exist, because Meta publishes no
        API for moving one to Cloud API and the documented path is the
        customer hand-deleting their account and losing all history.

        A greyed-out second option reads as "you did not qualify", and this
        merchant did not fail a check. So the reason is rendered as prose
        under the one real option, which is what the field was put there for.
      */}
      {explainsCoexistence(candidate) && coexistence ? (
        <section className={styles.fixHere} data-testid="connect-coexistence">
          <h3 className={styles.checkHeading}>{t('connect.coexistHeading')}</h3>
          <p className={styles.checkDetail}>{coexistence.keepUsingBusinessApp.description}</p>
          {coexistence.keepUsingBusinessApp.throughputNote ? (
            <p className={styles.checkDetail} data-testid="connect-throughput">
              {coexistence.keepUsingBusinessApp.throughputNote}
            </p>
          ) : null}
          {coexistence.keepUsingBusinessApp.limitations.length > 0 ? (
            <ul className={styles.checks} data-testid="connect-limitations">
              {coexistence.keepUsingBusinessApp.limitations.map((limit) => (
                <li key={limit} className={styles.checkDetail}>
                  {limit}
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.checkDetail} data-testid="connect-no-migration">
            {coexistence.fullMigration.reason} {t('connect.migrationNotPossible')}
          </p>
        </section>
      ) : null}

      {connectable ? (
        <Button
          size="sm"
          disabled={disabled}
          data-testid={`connect-action-${candidate.phoneNumberId}`}
          onClick={onConnect}
        >
          {candidate.alreadyConnectedHere ? t('connect.reconnect') : t('connect.action')}
        </Button>
      ) : null}
    </article>
  );
}
