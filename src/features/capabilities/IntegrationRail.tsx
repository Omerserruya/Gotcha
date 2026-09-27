import { getTranslations } from 'next-intl/server';

import { splitCatalogue, type Integration } from '@/api/contracts/integrations';

import { IntegrationFinder } from './IntegrationFinder';
import styles from './Capabilities.module.css';

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
 * ── THE READ AND ITS FAILURE STAY HERE; THE LISTS GO TO A CLIENT COMPONENT ──
 * Only the filter needs state. Keeping the failure branch on the server means a
 * catalogue read that failed still says so without shipping a filter for a list
 * that does not exist.
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
      <IntegrationFinder connected={connected} available={available} />
    </aside>
  );
}
