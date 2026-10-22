'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import {
  MESSENGER_SELECT_MAX,
  type MessengerCandidate,
  type MessengerPageResult,
} from '@/api/contracts/channels';
import { channelName } from '@/api/contracts/inbox';
import { Button } from '@/design-system/primitives/button/Button';
import { useRouter } from '@/i18n/navigation';

import { startChannelConnect } from './actions';
import {
  selectMessengerPages,
  type MessengerPagesRead,
  type MessengerSelectRefusal,
  type MessengerSelectResult,
} from './messenger-actions';
import styles from './Channels.module.css';

/**
 * Messenger's way back when the sign-in granted two or more Pages (backend
 * 0ce84f21): nothing was connected, and the person chooses here - inline over
 * the list, as a connect panel is.
 *
 *   - a Page another workspace owns is shown, with why, and has no checkbox:
 *     the route never overwrites it, so choosing it could only come back
 *     "taken"
 *   - a Page connected here can be chosen: the route reconnects it (new token,
 *     subscribed again) and never counts it against the plan's limit
 *   - nothing is chosen up front: connecting every Page granted is what this
 *     replaced
 *
 * Held in state from the first render, then the URL is tidied - as
 * `ChannelLanding` does - so the page keeps this mounted with `null`.
 */
export function MessengerPicker({
  pick,
}: {
  readonly pick: { readonly session: string; readonly read: MessengerPagesRead } | null;
}) {
  const t = useTranslations('channels.pick');
  const tc = useTranslations('channels');
  const router = useRouter();
  const [held, setHeld] = useState(pick);

  useEffect(() => {
    if (pick === null) return;
    router.replace('/settings/channels', { scroll: false });
  }, [pick, router]);

  if (!held) return null;
  const close = () => setHeld(null);
  return (
    <section className={`${styles.connect} ${styles.pick}`} data-testid="messenger-pick">
      <div className={styles.connectHead}>
        <span className={styles.connectTitle}>{t('heading')}</span>
        <button
          type="button"
          className={styles.connectClose}
          onClick={close}
          aria-label={tc('connect.close')}
          data-testid="messenger-pick-close"
        >
          ✕
        </button>
      </div>
      {held.read.ok ? (
        <Choose session={held.session} pages={held.read.pages} onClose={close} />
      ) : (
        <>
          <p className={styles.connectProblem} role="alert" data-testid="messenger-pick-problem">
            {t(`read.${held.read.reason}`)}
          </p>
          {/* No permission is not fixed by signing in to Meta again. */}
          {held.read.reason === 'forbidden' ? null : <ConnectAgain />}
        </>
      )}
    </section>
  );
}

function Choose({
  session,
  pages,
  onClose,
}: {
  readonly session: string;
  readonly pages: readonly MessengerCandidate[];
  readonly onClose: () => void;
}) {
  const t = useTranslations('channels.pick');
  const router = useRouter();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<MessengerSelectResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (outcome?.ok) return <Results results={outcome.results} onClose={onClose} />;

  const refused = outcome && !outcome.ok ? outcome : null;
  // The session is gone: there is nothing left to choose from.
  if (refused?.reason === 'expired') return <Refused reason="expired" results={[]} />;

  const selectable = pages.some((p) => !p.takenElsewhere);
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <p className={styles.pickLead}>{t('lead')}</p>
      <ul className={styles.pickList} data-testid="messenger-pick-pages">
        {pages.map((page) => (
          <li key={page.id} data-testid={`messenger-page-${page.id}`}>
            {page.takenElsewhere ? (
              <div className={styles.pickRow} data-taken="true">
                <PageText page={page} note={t('taken')} />
              </div>
            ) : (
              <label className={styles.pickRow}>
                <input
                  type="checkbox"
                  checked={chosen.has(page.id)}
                  onChange={() => toggle(page.id)}
                  data-testid={`messenger-pick-${page.id}`}
                />
                <PageText page={page} note={page.connectedHere ? t('here') : null} />
              </label>
            )}
          </li>
        ))}
      </ul>
      {selectable ? (
        <div className={styles.connectActions}>
          {chosen.size === 0 ? (
            <p className={styles.pickHint} role="status" data-testid="messenger-pick-hint">
              {t('chooseOne')}
            </p>
          ) : chosen.size > MESSENGER_SELECT_MAX ? (
            <p className={styles.pickHint} role="status" data-testid="messenger-pick-hint">
              {t('tooMany', { max: MESSENGER_SELECT_MAX })}
            </p>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={isPending}
              data-testid="messenger-pick-confirm"
              onClick={() =>
                startTransition(async () => {
                  setOutcome(null);
                  const result = await selectMessengerPages(session, [...chosen]);
                  setOutcome(result);
                  if (result.ok) router.refresh();
                })
              }
            >
              {isPending ? t('connecting') : t('confirm', { count: chosen.size })}
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            {t('later')}
          </Button>
        </div>
      ) : (
        <p className={styles.pickHint} role="status" data-testid="messenger-pick-none">
          {t('noneAvailable')}
        </p>
      )}
      {refused ? <Refused reason={refused.reason} results={refused.results} /> : null}
    </>
  );
}

function PageText({
  page,
  note,
}: {
  readonly page: MessengerCandidate;
  readonly note: string | null;
}) {
  return (
    <span className={styles.pickText}>
      <span className={styles.pickName}>
        <bdi>{page.name || page.id}</bdi>
      </span>
      {page.category ? (
        <span className={styles.pickMeta}>
          <bdi>{page.category}</bdi>
        </span>
      ) : null}
      {note ? <span className={styles.pickMeta}>{note}</span> : null}
    </span>
  );
}

function Refused({
  reason,
  results,
}: {
  readonly reason: MessengerSelectRefusal;
  readonly results: readonly MessengerPageResult[];
}) {
  const t = useTranslations('channels.pick');
  return (
    <>
      <p className={styles.connectProblem} role="alert" data-testid="messenger-pick-refused">
        {t(`refused.${reason}`)}
      </p>
      {results.length > 0 ? <ResultList results={results} /> : null}
      {reason === 'expired' || reason === 'unknown_page' ? <ConnectAgain /> : null}
    </>
  );
}

function Results({
  results,
  onClose,
}: {
  readonly results: readonly MessengerPageResult[];
  readonly onClose: () => void;
}) {
  const t = useTranslations('channels.pick');
  return (
    <>
      <p className={styles.pickLead}>{t('resultHeading')}</p>
      <ResultList results={results} />
      <div className={styles.connectActions}>
        <Button size="sm" onClick={onClose} data-testid="messenger-pick-done">
          {t('done')}
        </Button>
      </div>
    </>
  );
}

/** What happened to each Page, in words: never a status code. */
function ResultList({ results }: { readonly results: readonly MessengerPageResult[] }) {
  const t = useTranslations('channels.pick.result');
  return (
    <ul className={styles.pickList} data-testid="messenger-pick-results">
      {results.map((r, i) => {
        const deaf = r.subscribed === false && r.status !== 'taken' && r.status !== 'unknown';
        const ok = (r.status === 'connected' || r.status === 'reconnected') && !deaf;
        return (
          <li
            key={r.id || i}
            className={styles.pickResult}
            data-outcome={ok ? 'ok' : 'problem'}
            data-testid={`messenger-result-${r.id || i}`}
          >
            <span className={styles.pickName}>
              <bdi>{r.name || r.id}</bdi>
            </span>
            <span className={styles.pickMeta}>
              {deaf ? t(`${r.status as 'connected' | 'reconnected'}NotSubscribed`) : t(r.status)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A session that is gone is started again where every Messenger connect starts. */
function ConnectAgain() {
  const t = useTranslations('channels.pick');
  const tc = useTranslations('channels');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const name = channelName('MESSENGER', tc) ?? tc('name.other');
  return (
    <>
      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          disabled={isPending}
          data-testid="messenger-pick-again"
          onClick={() =>
            startTransition(async () => {
              setProblem(null);
              const start = await startChannelConnect('MESSENGER');
              if (start.ok) {
                window.location.assign(start.url);
                return;
              }
              setProblem(tc(`connect.start.${start.reason}`, { channel: name }));
            })
          }
        >
          {isPending ? t('opening') : t('again')}
        </Button>
      </div>
      {problem ? (
        <p
          className={styles.connectProblem}
          role="alert"
          data-testid="messenger-pick-again-problem"
        >
          {problem}
        </p>
      ) : null}
    </>
  );
}
