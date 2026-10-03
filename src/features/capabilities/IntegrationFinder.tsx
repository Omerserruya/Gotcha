'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Link } from '@/i18n/navigation';

import { humaniseCode } from '@/api/contracts/capabilities';
import { byCategory, isIntegrationState, type Integration } from '@/api/contracts/integrations';

import styles from './Capabilities.module.css';

/**
 * Screen 10's rail contents — what is connected, what could be, and a way to
 * find one of seventeen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS IS A CLIENT COMPONENT AND THE RAIL AROUND IT IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * Only the filter needs state. The rail keeps the read and its failure branch on
 * the server, and hands the lists here — so a failed catalogue read still says
 * so without shipping a filter for a list that does not exist.
 *
 * ── WHAT THE SEARCH MATCHES, AND WHY IT SAYS SO ──
 * Name, description and category. **Not the tool names underneath**, because a
 * match on a tool would put an integration in the results for a word that is
 * nowhere on its row, and a reader cannot tell why it is there. The placeholder
 * names the three fields rather than saying "Search", which is a label that
 * promises everything.
 *
 * ── AND NO CONNECT BUTTON, WHICH IS A DECISION AND NOT AN OMISSION ──
 * `POST /:slug/connect` takes a `credentials` object and there is no OAuth
 * redirect anywhere in it. So a Connect control is two different things:
 *
 *   · `OAUTH2` — a re-authorisation at the provider, whose callback returns to
 *     whichever app `FRONTEND_URL` names. **That is not this app.** Same
 *     blocker as screen 13's connect flow, for the same reason.
 *   · everything else — a credentials form whose fields live in `authSchema`,
 *     which this screen deliberately does not read because it carries the raw
 *     OAuth scopes.
 *
 * A single "Connect" button over those two would work for neither. It is a
 * missing primary action of the kind already ruled on, not a gap to paper over.
 * So 02's "Connect" is drawn on each row, not live, with that reason.
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
      <div className={styles.railSearch}>
        <label className="srOnly" htmlFor="integration-search">
          {t('rail.searchLabel')}
        </label>
        <input
          id="integration-search"
          type="search"
          className={styles.railSearchInput}
          data-testid="integration-search"
          value={query}
          placeholder={t('rail.searchPlaceholder')}
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
        <h2 className={styles.railHeading}>
          {matches.filtering
            ? t('rail.connectedOf', { count: matches.connected.length, total: connected.length })
            : t('rail.connected', { count: connected.length })}
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
                <span className={styles.railTile} aria-hidden="true" />
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
                  <span className={styles.railTile} aria-hidden="true" />
                  <span className={styles.railName}>{entry.name}</span>
                  {/*
                    ★ A BROKEN CONNECTION STAYS IN "CONNECTED", WITH ITS STATE —
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
          {matches.filtering
            ? t('rail.availableOf', { count: matches.available.length, total: available.length })
            : t('rail.available', { count: available.length })}
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
            <li
              key={entry.slug}
              className={styles.railRowStatic}
              data-testid={`available-${entry.slug}`}
            >
              <span className={styles.railTile} aria-hidden="true" />
              <span className={styles.railNameStack}>
                <span className={styles.railName}>{entry.name}</span>
                <span className={styles.railSub}>
                  {[entry.category ? humaniseCode(entry.category) : null, entry.description]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span
                className={styles.railConnect}
                aria-disabled="true"
                title={t('rail.connectNotHere')}
              >
                {t('rail.connect')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
