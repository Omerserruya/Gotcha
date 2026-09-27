'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

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
 */
export function IntegrationFinder({
  connected,
  available,
}: {
  readonly connected: readonly Integration[];
  readonly available: readonly Integration[];
}) {
  const t = useTranslations('capabilities');
  const [query, setQuery] = useState('');

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

  return (
    <>
      <div className={styles.railSearch}>
        <label className={styles.railSearchLabel} htmlFor="integration-search">
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
        Two empty sections under two headings reading "Connected · 0" and
        "Available · 0" is indistinguishable from a tenant with no integrations
        and from a failed read. The term is quoted back, because the commonest
        cause is a typo the reader cannot see in their own input.
      */}
      {matches.filtering && found === 0 ? (
        <p className={styles.railNote} data-testid="integration-search-none">
          {t('rail.searchNone', { term: query.trim() })}
        </p>
      ) : null}

      <section data-testid="rail-connected">
        {/*
          The heading counts what is SHOWN while filtering and what exists
          otherwise, and says which it is doing. A count that silently changes
          meaning is how "Connected · 1" comes to mean two different things on
          one screen.
        */}
        <h2 className={styles.railHeading}>
          {matches.filtering
            ? t('rail.connectedOf', { count: matches.connected.length, total: connected.length })
            : t('rail.connected', { count: connected.length })}
        </h2>
        {connected.length === 0 ? (
          <p className={styles.railNote} data-testid="rail-none-connected">
            {t('rail.noneConnected')}
          </p>
        ) : (
          <ul className={styles.railList}>
            {matches.connected.map((entry) => (
              <li
                key={entry.slug}
                className={styles.railItem}
                data-testid={`connected-${entry.slug}`}
              >
                <span>{entry.name}</span>
                {/*
                  ★ A BROKEN CONNECTION STAYS IN "CONNECTED", WITH ITS STATE.
                  Moving it to "available" would offer a Connect button for
                  something already connected.

                  The state's NAME, not its enum — this rendered `CONNECTED` /
                  `ERROR` verbatim on an operational screen. `INTEGRATION_STATES`
                  is closed, so anything outside it says "status unknown" rather
                  than printing a code a reader cannot act on. And no date beside
                  it: the only timestamp available is a credential check, not a
                  sync.
                */}
                {entry.tenantConnection?.status ? (
                  <span
                    className={styles.railState}
                    data-state={entry.tenantConnection.status}
                    data-testid={`connected-state-${entry.slug}`}
                  >
                    {isIntegrationState(entry.tenantConnection.status)
                      ? t(`rail.state.${entry.tenantConnection.status}` as 'rail.state.CONNECTED')
                      : t('rail.stateUnknown')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="rail-available">
        <h2 className={styles.railHeading}>
          {matches.filtering
            ? t('rail.availableOf', { count: matches.available.length, total: available.length })
            : t('rail.available', { count: available.length })}
        </h2>

        {/*
          Grouped by the catalogue's own `category`, in `sortOrder` — the order
          somebody chose, not alphabetical. An entry with no category keeps its
          own group rather than being assigned one, because inventing a category
          is how a filter starts lying about what it contains.

          A group whose every entry is filtered out disappears with them: an
          empty category heading is a claim that the category has nothing in it.
        */}
        {byCategory(matches.available).map((group) => (
          <div key={group.category ?? 'uncategorised'} className={styles.railGroup}>
            {/*
              ★★ THE CATEGORY, WHICH ARRIVED AS `PROJECT_MANAGEMENT`. A
              free-text column with no catalogue behind it, so there is no label
              to look up — it is made readable rather than translated, and that
              is stated because a reader will wonder why this one is not in the
              message file.
            */}
            <h3 className={styles.railGroupHeading}>
              {group.category ? humaniseCode(group.category) : t('rail.uncategorised')}
            </h3>
            <ul className={styles.railList}>
              {group.entries.map((entry) => (
                <li
                  key={entry.slug}
                  className={styles.railItem}
                  data-testid={`available-${entry.slug}`}
                >
                  {entry.name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
