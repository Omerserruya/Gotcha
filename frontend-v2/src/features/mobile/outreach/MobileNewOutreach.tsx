'use client';

import { MessageCircle, PhoneOutgoing, Plus, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

import { Sheet, SheetContent } from '@/design-system/primitives/overlay/Dialog';
import { startCall, type StartCallResult } from '@/features/calls/actions';
import { pastedNumber } from '@/features/calls/dial';
import { initials } from '@/features/inbox/initials';
import { useRouter } from '@/i18n/navigation';
import { appPath } from '@/lib/base-path';
import { typedDir } from '@/lib/typed-dir';
import { PERMISSIONS } from '@/permissions/catalogue';
import { usePermissions } from '@/permissions/permissions-context';

import ui from '../mobile-ui.module.css';
import styles from './mobile-new-outreach.module.css';
import { callOutcomeKey, pickQuery } from './mobile-outreach';
import { findPeople, newestConversationOf, type PickPerson } from './new-outreach-actions';

/** How long the picker waits after the last keystroke before it searches. */
const SEARCH_DELAY_MS = 300;

type Stage =
  | { readonly at: 'closed' }
  | { readonly at: 'choose' }
  | { readonly at: 'pick'; readonly purpose: 'message' | 'call' }
  | { readonly at: 'confirm'; readonly to: string; readonly name: string };

/**
 * The design's "New outreach" on the phone: the floating button, then a
 * sheet with two ways to reach one person (Omer, 2026-11-03).
 *
 *   Message  pick a customer, and their newest conversation opens - where
 *            the composer already keeps the reply window and offers the
 *            templates. With no conversation yet it says so: a first
 *            message is started from the website for now (the platform has
 *            no way to start a conversation from a person).
 *   Call     pick a customer with a phone, or type a number, confirm, and
 *            `startCall` - the website dialer's own action. The line decides
 *            what happens: AGENT_FIRST rings the line's agent first, then the
 *            customer; IN_PLATFORM dials from a browser phone the app does not
 *            have, so nothing was dialled, and that is said.
 *
 * ★ Call only with `outbound:calls:create`, the permission the route checks:
 *   without it the choice is not offered rather than refused after a tap.
 * ★ Campaigns, emails and templates stay on the website, one link away.
 *
 * ⚠⚠ A CALL RINGS A REAL PHONE. Only the confirmation's own button places
 *    it; nothing automated presses it, on dev or anywhere.
 */
export function MobileNewOutreach() {
  const t = useTranslations('mobile.outreach');
  const { canSee } = usePermissions();
  const canCall = canSee(PERMISSIONS.outbound.calls.create);
  const [stage, setStage] = useState<Stage>({ at: 'closed' });

  return (
    <>
      <button
        type="button"
        className={ui.fab}
        onClick={() => setStage({ at: 'choose' })}
        data-testid="mobile-outreach-new"
      >
        <Plus size={22} strokeWidth={2} aria-hidden="true" />
        {t('new')}
      </button>
      <Sheet
        open={stage.at !== 'closed'}
        onOpenChange={(open) => !open && setStage({ at: 'closed' })}
      >
        {stage.at === 'choose' ? (
          <Choose canCall={canCall} onPick={(purpose) => setStage({ at: 'pick', purpose })} />
        ) : stage.at === 'pick' ? (
          <Pick
            purpose={stage.purpose}
            onBack={() => setStage({ at: 'choose' })}
            onCall={(to, name) => setStage({ at: 'confirm', to, name })}
          />
        ) : stage.at === 'confirm' ? (
          <Confirm
            to={stage.to}
            name={stage.name}
            onBack={() => setStage({ at: 'pick', purpose: 'call' })}
            onDone={() => setStage({ at: 'closed' })}
          />
        ) : null}
      </Sheet>
    </>
  );
}

function Choose({
  canCall,
  onPick,
}: {
  readonly canCall: boolean;
  readonly onPick: (purpose: 'message' | 'call') => void;
}) {
  const t = useTranslations('mobile.outreach');
  const locale = useLocale();
  const options: readonly {
    readonly id: 'message' | 'call';
    readonly icon: typeof MessageCircle;
  }[] = [
    { id: 'message', icon: MessageCircle },
    ...(canCall ? [{ id: 'call' as const, icon: PhoneOutgoing }] : []),
  ];
  return (
    <SheetContent title={t('newTitle')} data-testid="mobile-outreach-choose">
      <div className={styles.options} data-count={options.length}>
        {options.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={styles.option}
            onClick={() => onPick(id)}
            data-testid={`mobile-outreach-choose-${id}`}
          >
            <span className={styles.optionIcon} aria-hidden="true">
              <Icon size={20} strokeWidth={2} />
            </span>
            <span className={styles.optionTitle}>{t(`choice.${id}.title`)}</span>
            <span className={styles.optionSub}>{t(`choice.${id}.sub`)}</span>
          </button>
        ))}
      </div>
      {/* The website, a full load: the native shell opens it in the browser. */}
      <p className={styles.foot}>
        {t('campaignsOnWebsite')}{' '}
        <a href={appPath(`/${locale}/outreach`)} className={ui.footLink}>
          {t('toWebsite')}
        </a>
      </p>
    </SheetContent>
  );
}

function Pick({
  purpose,
  onBack,
  onCall,
}: {
  readonly purpose: 'message' | 'call';
  readonly onBack: () => void;
  readonly onCall: (to: string, name: string) => void;
}) {
  const t = useTranslations('mobile.outreach');
  const locale = useLocale();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<
    { readonly query: string; readonly people: readonly PickPerson[] } | 'failed' | null
  >(null);
  const [searching, startSearch] = useTransition();
  const [opening, setOpening] = useState<string | null>(null);
  /** A person with no conversation yet, or a conversation that could not be found. */
  const [notice, setNotice] = useState<
    { readonly kind: 'none'; readonly person: PickPerson } | { readonly kind: 'failed' } | null
  >(null);
  const latest = useRef('');

  const q = pickQuery(query);
  useEffect(() => {
    latest.current = q;
    // Nothing asked: nothing is read, and nothing found is shown (`people` below).
    if (q === '') return;
    const timer = setTimeout(() => {
      startSearch(async () => {
        const result = await findPeople(q);
        // An older search that answers late is not this one's answer.
        if (latest.current !== q) return;
        setFound(result.ok ? { query: q, people: result.people } : 'failed');
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const typed = purpose === 'call' ? pastedNumber(query) : null;
  // The last answer stays drawn while the next search runs; an empty field shows none.
  const people = q !== '' && found !== null && found !== 'failed' ? found.people : [];

  const choose = async (person: PickPerson) => {
    setNotice(null);
    if (purpose === 'call') {
      if (person.phone) onCall(person.phone, person.name);
      return;
    }
    setOpening(person.id);
    const result = await newestConversationOf(person.id);
    setOpening(null);
    if (!result.ok) return setNotice({ kind: 'failed' });
    if (result.conversationId === null) return setNotice({ kind: 'none', person });
    router.push(`/m/inbox/${encodeURIComponent(result.conversationId)}` as '/m/inbox');
  };

  return (
    <SheetContent title={t(`pickTitle.${purpose}`)} data-testid={`mobile-outreach-pick-${purpose}`}>
      <div className={ui.search}>
        <Search size={19} strokeWidth={2} aria-hidden="true" />
        <input
          className={ui.searchInput}
          value={query}
          dir={typedDir(query)}
          type="search"
          inputMode={purpose === 'call' ? 'search' : undefined}
          placeholder={t(`pickSearch.${purpose}`)}
          aria-label={t(`pickSearch.${purpose}`)}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="mobile-outreach-search"
        />
      </div>

      {notice?.kind === 'none' ? (
        <p className={styles.notice} role="status" data-testid="mobile-outreach-no-conversation">
          {t('noConversation', { name: notice.person.name })}{' '}
          <a
            href={appPath(`/${locale}/customers/${encodeURIComponent(notice.person.id)}`)}
            className={ui.footLink}
          >
            {t('toWebsite')}
          </a>
        </p>
      ) : notice?.kind === 'failed' ? (
        <p className={styles.notice} role="alert" data-testid="mobile-outreach-open-failed">
          {t('openFailed')}
        </p>
      ) : null}

      <ul
        className={styles.people}
        aria-busy={searching || undefined}
        data-testid="mobile-outreach-people"
      >
        {typed ? (
          <li>
            <button
              type="button"
              className={`${ui.row} ${styles.person}`}
              onClick={() => onCall(typed, typed)}
              data-testid="mobile-outreach-typed-number"
            >
              <span className={ui.avatar} aria-hidden="true">
                <PhoneOutgoing size={20} strokeWidth={2} />
              </span>
              <span className={ui.rowBody}>
                <span className={ui.rowTitle} dir="ltr">
                  {typed}
                </span>
                <span className={ui.rowSub}>{t('typedNumber')}</span>
              </span>
            </button>
          </li>
        ) : null}
        {people.map((person) => {
          const unreachable = purpose === 'call' && person.phone === null;
          return (
            <li key={person.id}>
              <button
                type="button"
                className={`${ui.row} ${styles.person}`}
                disabled={unreachable || opening !== null}
                onClick={() => void choose(person)}
                data-testid={`mobile-outreach-person-${person.id}`}
              >
                <span className={ui.avatar} aria-hidden="true">
                  {initials(person.name)}
                </span>
                <span className={ui.rowBody}>
                  <span className={ui.rowTitle}>{person.name}</span>
                  <span className={ui.rowSub}>
                    {opening === person.id ? (
                      t('opening')
                    ) : person.phone ? (
                      <bdi dir="ltr">{person.phone}</bdi>
                    ) : unreachable ? (
                      t('noPhone')
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className={styles.status} role="status">
        {q === ''
          ? t(`pickHint.${purpose}`)
          : found === 'failed'
            ? t('searchFailed')
            : searching || found === null || found.query !== q
              ? t('searching')
              : people.length === 0 && !typed
                ? t('noMatch')
                : null}
      </p>

      <button
        type="button"
        className={ui.quiet}
        onClick={onBack}
        data-testid="mobile-outreach-back"
      >
        {t('sheetBack')}
      </button>
    </SheetContent>
  );
}

function Confirm({
  to,
  name,
  onBack,
  onDone,
}: {
  readonly to: string;
  readonly name: string;
  readonly onBack: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('mobile.outreach');
  const dialer = useTranslations('calls.dialer');
  const [result, setResult] = useState<StartCallResult | null>(null);
  const [calling, startCalling] = useTransition();
  const sameAsNumber = name === to;

  return (
    <SheetContent
      title={sameAsNumber ? t('confirmNumber') : t('confirmTitle', { name })}
      data-testid="mobile-outreach-confirm"
    >
      <p className={styles.confirmBody}>
        {t('confirmBody')} <bdi dir="ltr">{to}</bdi>
      </p>
      {result ? (
        <p
          className={styles.notice}
          role="status"
          data-kind={result.ok ? 'ok' : 'problem'}
          data-testid="mobile-outreach-call-result"
        >
          {dialer(callOutcomeKey(result, (key) => dialer.has(key)) as 'ringing')}
        </p>
      ) : null}
      <div className={styles.actions}>
        {result?.ok ? (
          <button type="button" className={ui.primary} onClick={onDone}>
            {t('close')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={ui.primary}
              disabled={calling}
              onClick={() => {
                setResult(null);
                startCalling(async () => setResult(await startCall(to)));
              }}
              data-testid="mobile-outreach-call"
            >
              <PhoneOutgoing size={17} strokeWidth={2} aria-hidden="true" />
              {calling ? dialer('starting') : t('callNow')}
            </button>
            <button type="button" className={ui.secondary} disabled={calling} onClick={onBack}>
              {t('sheetBack')}
            </button>
          </>
        )}
      </div>
    </SheetContent>
  );
}
