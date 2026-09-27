import { getTranslations } from 'next-intl/server';

import { byCategory, splitCatalogue, type Integration } from '@/api/contracts/integrations';

import styles from './Capabilities.module.css';
import { humaniseCode } from '@/api/contracts/capabilities';
import { isIntegrationState } from '@/api/contracts/integrations';

/**
 * Screen 10's left rail — what is connected, and what could be.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE COUNT IS WHATEVER THE TABLE HOLDS
 * ════════════════════════════════════════════════════════════════════════════
 * The design draws *"Available · 58"* over ten named providers — WooCommerce,
 * Wix, Stripe, PayPlus, Israel Post, Cargo, Priority, Salesforce, Calendly,
 * Zoom. `IntegrationCatalog` has **17 published rows on dev**, and most of
 * those names are not among them.
 *
 * This renders what is there. Printing 58 above a list of 17, or padding the
 * list with providers that have no row, would imply coverage the product
 * does not have — the same defect as a knowledge counter made of candidates
 * nobody accepted. Each missing provider is a catalogue row plus an adapter,
 * which is a decision rather than a gap to paper over.
 *
 * ── AND NOTHING HERE SAYS "LAST SYNCED" ──
 * The route is explicit: `lastTestedAt` is a CONNECTION TEST and *"there is
 * no sync concept for integrations anywhere in this system — nothing records
 * 'pulled N records at T' — so this must never be surfaced or renamed as
 * 'last synced'. It would tell a customer their data is current when all
 * that happened is a credential check passing."* Wrong in the reassuring
 * direction, which is the worst one.
 */
export async function IntegrationRail({
  integrations,
}: {
  /** `null` when the read failed. Never an empty catalogue. */
  readonly integrations: readonly Integration[] | null;
}) {
  const t = await getTranslations('capabilities');

  if (integrations === null) {
    return (
      <aside className={styles.rail} data-testid="rail-unavailable">
        <p className={styles.railNote}>{t('rail.unavailable')}</p>
      </aside>
    );
  }

  const { connected, available } = splitCatalogue(integrations);

  return (
    <aside className={styles.rail} data-testid="integration-rail">
      <section data-testid="rail-connected">
        <h2 className={styles.railHeading}>{t('rail.connected', { count: connected.length })}</h2>
        {connected.length === 0 ? (
          <p className={styles.railNote} data-testid="rail-none-connected">
            {t('rail.noneConnected')}
          </p>
        ) : (
          <ul className={styles.railList}>
            {connected.map((entry) => (
              <li
                key={entry.slug}
                className={styles.railItem}
                data-testid={`connected-${entry.slug}`}
              >
                <span>{entry.name}</span>
                {/*
                  ★ A BROKEN CONNECTION STAYS IN "CONNECTED", WITH ITS STATE.
                  Moving it to "available" would offer a Connect button for
                  something already connected — the distinction 14c, 04d and
                  05d each had to make on their own.

                  The state is the platform's word, rendered rather than
                  reinterpreted, and no date goes next to it: the only
                  timestamp available is a credential check, not a sync.
                */}
                {entry.tenantConnection?.status ? (
                  <span
                    className={styles.railState}
                    data-state={entry.tenantConnection.status}
                    data-testid={`connected-state-${entry.slug}`}
                  >
                    {/*
                      ★★ THE STATE'S NAME, NOT ITS ENUM. This rendered
                      `CONNECTED` / `ERROR` / `PENDING` verbatim on an
                      operational screen. `INTEGRATION_STATES` has five
                      members, so the mapping is closed; anything outside it
                      says "status unknown" rather than printing a code, since
                      a reader cannot act on a value we do not recognise.
                    */}
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
        <h2 className={styles.railHeading}>{t('rail.available', { count: available.length })}</h2>

        {/*
          Grouped by the catalogue's own `category`, in `sortOrder` — the
          order somebody chose, not alphabetical. An entry with no category
          keeps its own group rather than being assigned one, because
          inventing a category is how a filter starts lying about what it
          contains.
        */}
        {byCategory(available).map((group) => (
          <div key={group.category ?? 'uncategorised'} className={styles.railGroup}>
            {/*
              ★★ AND THE CATEGORY, WHICH ARRIVED AS `PROJECT_MANAGEMENT`.
              A free-text column with no catalogue behind it, so there is no
              label to look up — it is made readable rather than translated,
              and that is stated because a reader will wonder why this one is
              not in the message file. `humaniseCode` is shared with the tool
              names for exactly that reason.
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
    </aside>
  );
}
