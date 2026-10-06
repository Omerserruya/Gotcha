'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Search } from 'lucide-react';

import { Link } from '@/i18n/navigation';

import { humaniseCode } from '@/api/contracts/capabilities';
import { byCategory, isIntegrationState, type Integration } from '@/api/contracts/integrations';

import { IntegrationLogo } from './IntegrationLogo';
import styles from './Capabilities.module.css';

/**
 * Screen 10's rail contents - what is connected, what could be, and a way to
 * find one of seventeen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS IS A CLIENT COMPONENT AND THE RAIL AROUND IT IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * Only the filter needs state. The rail keeps the read and its failure branch on
 * the server, and hands the lists here - so a failed catalogue read still says
 * so without shipping a filter for a list that does not exist.
 *
 * ── WHAT THE SEARCH MATCHES, AND WHY IT SAYS SO ──
 * Name, description and category. **Not the tool names underneath**, because a
 * match on a tool would put an integration in the results for a word that is
 * nowhere on its row, and a reader cannot tell why it is there. The placeholder
 * names the three fields rather than saying "Search", which is a label that
 * promises everything.
 *
 * ── CONNECT IS ON EACH SYSTEM'S OWN SCREEN ──
 * Every available row opens `?system=<slug>`: the system's mark, what it is,
 * what it brings, and Connect (Omer, 2026-10-04). Its "Connect" here is the
 * way there, not a second control - how a system connects (a credentials
 * form, or OAuth at the provider) is that screen's to say. See
 * `AvailableSystem`.
 *
 * ── 10, MEASURED ──
 * The search (`8px 11px`, white, radius 9); CONNECTED, a row per system that
 * selects it (`?system=`) and says how many actions it brings, or its state
 * when it is not plain connected; AVAILABLE with a count, category chips
 * (`4px 9px`, radius 7) and a row per system. The built-in actions belong to
 * no provider, so they are a row of their own at the top.
 */
export function IntegrationFinder({
  connected,
  available,
  actionCounts,
  builtInCount,
  selected,
}: {
  readonly connected: readonly Integration[];
  readonly available: readonly Integration[];
  /** Actions per connected system's slug. */
  readonly actionCounts: Readonly<Record<string, number>>;
  /** Actions that belong to no provider. 0 hides the row. */
  readonly builtInCount: number;
  /** `builtin`, a slug, or null. */
  readonly selected: string | null;
}) {
  const t = useTranslations('capabilities');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const term = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (term === '') return { connected, available, filtering: false };
    const hit = (entry: Integration) =>
      [entry.name, entry.description ?? '', entry.category ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term);
    return {
      connected: connected.filter(hit),
      available: available.filter(hit),
      filtering: true,
    };
  }, [connected, available, term]);

  const found = matches.connected.length + matches.available.length;
  // From what the search left: a chip for a category with nothing in it would
  // claim the category is empty.
  const categories = byCategory(matches.available)
    .map((group) => group.category)
    .filter((c): c is string => c !== null);
  const shown = category
    ? matches.available.filter((entry) => entry.category?.trim() === category)
    : matches.available;

  return (
    <>
      {/* 02's search: a magnifier and how many there are. No ⌘K: no shortcut exists. */}
      <div className={styles.railSearch}>
        <label className="srOnly" htmlFor="integration-search">
          {t('rail.searchLabel')}
        </label>
        <Search className={styles.railSearchIcon} aria-hidden="true" size={14} />
        <input
          id="integration-search"
          type="search"
          className={styles.railSearchInput}
          data-testid="integration-search"
          value={query}
          placeholder={t('rail.searchCount', { count: connected.length + available.length })}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {/*
        ★★ A FILTER THAT HIDES EVERYTHING MUST SAY SO IN THE READER'S OWN WORDS.
        The term is quoted back: the commonest cause is a typo the reader
        cannot see in their own input.
      */}
      {matches.filtering && found === 0 ? (
        <p className={styles.railNote} data-testid="integration-search-none">
          {t('rail.searchNone', { term: query.trim() })}
        </p>
      ) : null}

      <section className={styles.railSection} data-testid="rail-connected">
        {/* The count is what is SHOWN while filtering, and says which. */}
        {/* 02: the label, and its count at the row's end. */}
        <h2 className={styles.railHeading}>
          <span>{t('rail.connectedLabel')}</span>
          <span>
            {matches.filtering
              ? t('rail.countOf', { count: matches.connected.length, total: connected.length })
              : connected.length}
          </span>
        </h2>
        <ul className={styles.railList}>
          {builtInCount > 0 && !matches.filtering ? (
            <li>
              <Link
                href={{ pathname: '/studio/capabilities', query: { system: 'builtin' } }}
                className={styles.railRow}
                aria-current={selected === 'builtin' ? 'page' : undefined}
                data-testid="connected-builtin"
              >
                <IntegrationLogo slug={null} size="rail" />
                <span className={styles.railName}>{t('rail.builtIn')}</span>
                <span className={styles.railCount}>
                  {t('rail.actions', { count: builtInCount })}
                </span>
              </Link>
            </li>
          ) : null}
          {matches.connected.map((entry) => {
            const state = entry.tenantConnection?.status;
            return (
              <li key={entry.slug}>
                <Link
                  href={{ pathname: '/studio/capabilities', query: { system: entry.slug } }}
                  className={styles.railRow}
                  aria-current={selected === entry.slug ? 'page' : undefined}
                  data-testid={`connected-${entry.slug}`}
                >
                  <IntegrationLogo slug={entry.slug} size="rail" />
                  <span className={styles.railName}>{entry.name}</span>
                  {/*
                    ★ A BROKEN CONNECTION STAYS IN "CONNECTED", WITH ITS STATE -
                    its NAME, never the enum. Plain connected says what it
                    brings instead: how many actions.
                  */}
                  {state && state !== 'CONNECTED' ? (
                    <span
                      className={styles.railState}
                      data-state={state}
                      data-testid={`connected-state-${entry.slug}`}
                    >
                      {isIntegrationState(state)
                        ? t(`rail.state.${state}` as 'rail.state.CONNECTED')
                        : t('rail.stateUnknown')}
                    </span>
                  ) : (
                    <span
                      className={styles.railCount}
                      data-testid={`connected-state-${entry.slug}`}
                    >
                      {t('rail.actions', { count: actionCounts[entry.slug] ?? 0 })}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        {connected.length === 0 && builtInCount === 0 ? (
          <p className={styles.railNote} data-testid="rail-none-connected">
            {t('rail.noneConnected')}
          </p>
        ) : null}
      </section>

      <section className={styles.railSection} data-testid="rail-available">
        <h2 className={styles.railHeadingRule}>
          <span>{t('rail.availableLabel')}</span>
          <span>
            {matches.filtering
              ? t('rail.countOf', { count: matches.available.length, total: available.length })
              : available.length}
          </span>
        </h2>

        {/*
          The catalogue's own categories, in its order, as chips. A free-text
          column with no catalogue behind it, so each is made readable rather
          than translated.
        */}
        {categories.length > 1 ? (
          <div className={styles.railChips} role="group" aria-label={t('rail.categories')}>
            <button
              type="button"
              className={styles.railChip}
              aria-pressed={category === null}
              onClick={() => setCategory(null)}
            >
              {t('rail.all')}
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.railChip}
                aria-pressed={category === c}
                data-testid={`category-${c}`}
                onClick={() => setCategory(category === c ? null : c)}
              >
                {humaniseCode(c)}
              </button>
            ))}
          </div>
        ) : null}

        <ul className={styles.railList}>
          {shown.map((entry) => (
            <li key={entry.slug}>
              {/* Its own screen, where Connect is (Omer, 2026-10-04). */}
              <Link
                href={{ pathname: '/studio/capabilities', query: { system: entry.slug } }}
                className={`${styles.railRow} ${styles.railRowAvailable}`}
                aria-current={selected === entry.slug ? 'page' : undefined}
                data-testid={`available-${entry.slug}`}
              >
                <IntegrationLogo slug={entry.slug} size="rail" />
                <span className={styles.railNameStack}>
                  <span className={styles.railName}>{entry.name}</span>
                  <span className={styles.railSub}>
                    {[entry.category ? humaniseCode(entry.category) : null, entry.description]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className={styles.railConnect}>{t('rail.connect')}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
