import { getLocale, getTranslations } from 'next-intl/server';

import {
  connectedButFailing,
  electable,
  isInferred,
  partState,
  type RolePart,
} from '@/api/contracts/business-core';
import {
  hasOwnWords,
  humaniseToolName,
  isTheAdminsChoice,
  resolveAvailability,
  type Capability,
} from '@/api/contracts/capabilities';
import type { Integration } from '@/api/contracts/integrations';
import drawer from '@/design-system/styles/drawer.module.css';
import { PermissionChoice } from '@/features/capabilities/PermissionChoice';
import { Link } from '@/i18n/navigation';

import { CHIP_TONE } from './BusinessCore';
import styles from './BusinessCore.module.css';
import { ElectPart } from './ElectPart';

/**
 * 14c / 14d, measured: one part's drawer — which connection plays it, what
 * GOTCHA reads there, and what it may do there.
 *
 * Connection: the system playing the part, then — where the server would
 * accept a choice — 14c's choice of the CONNECTED candidates (ElectPart,
 * live), then the ones not connected, each going to Integrations.
 * What it may do: the system's actions with 10's own control
 * (PermissionChoice, live), or why an action is not the admin's choice.
 * What it reads: nothing serves what a part reads, or how much of it — "—".
 */
export async function PartDrawer({
  part,
  capabilities,
  integration = null,
  storeHost = null,
}: {
  readonly part: RolePart;
  readonly capabilities: readonly Capability[] | null;
  /** The playing system's record: its own action catalogue and last check. */
  readonly integration?: Integration | null;
  /** The store's own host, when it is known to be this system's. */
  readonly storeHost?: string | null;
}) {
  const t = await getTranslations('business-core');
  const tc = await getTranslations('capabilities');
  const locale = await getLocale();
  const state = partState(part);
  const failing = part.candidates.find((c) => connectedButFailing(c));
  const playing = part.elected?.name ?? failing?.name ?? null;
  const playingSlug = part.elected?.slug ?? failing?.slug ?? null;
  const connected = part.candidates.filter((c) => c.connected);
  const available = part.candidates.filter((c) => !c.connected && !connectedButFailing(c));
  const actions = playingSlug
    ? (capabilities ?? []).filter((c) => c.integration === playingSlug)
    : [];
  /*
    The system's OWN catalogue of actions — refund, cancel, … — from its
    integration record. `GET /tool-permissions` lists a system's actions only
    once each is provisioned and enabled, and writes are never auto-
    provisioned; so for a broken or new connection it lists none, and the
    actions are drawn from the catalogue with why they cannot be set yet.
  */
  const catalogue = integration?.catalogTools ?? [];
  const capabilityFor = (slug: string) =>
    (capabilities ?? []).find(
      (c) => c.toolName === `${playingSlug}.${slug}` || c.toolName === `integration.${slug}`,
    ) ?? null;
  const failingNow = state === 'connected_but_failing';
  const checked = integration?.tenantConnection?.lastTestedAt ?? null;

  return (
    <div className={drawer.drawerBody} data-testid={`part-drawer-${part.role}`}>
      <div className={drawer.field}>
        <span className={drawer.fieldLabel}>{t('drawer.connection')}</span>
        <div className={styles.drawerSystem} data-testid="part-playing">
          <span className={styles.drawerSystemText}>
            <span className={styles.drawerSystemName}>{playing ?? '—'}</span>
            {storeHost || checked ? (
              <span className={styles.drawerSystemSub} data-testid="part-playing-sub">
                {[
                  storeHost,
                  checked
                    ? t('drawer.checked', {
                        date: new Intl.DateTimeFormat(locale, {
                          day: 'numeric',
                          month: 'short',
                        }).format(new Date(checked)),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
          </span>
          <span className={styles.chip} data-tone={CHIP_TONE[state]}>
            {t(`chip.${isInferred(part) && state === 'chosen' ? 'inferred' : state}`)}
          </span>
        </div>
      </div>

      {electable(part) ? <ElectPart part={part} /> : null}

      {connected.length > 0 ? (
        <section className={styles.drawerGroup}>
          <h4 className={styles.drawerEyebrow}>{t('drawer.connectedIn')}</h4>
          <ul className={styles.drawerList}>
            {connected.map((c) => (
              <li key={c.slug} className={styles.drawerListRow}>
                {c.name}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {available.length > 0 ? (
        <section className={styles.drawerGroup}>
          <h4 className={styles.drawerEyebrow}>{t('drawer.available')}</h4>
          <ul className={styles.drawerList}>
            {available.map((c) => (
              <li key={c.slug} className={styles.drawerListRow}>
                <span>{c.name}</span>
                <Link
                  href={{ pathname: '/studio/capabilities', query: { system: c.slug } }}
                  className={styles.drawerLink}
                >
                  {t('drawer.connect')}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h3 className={drawer.sectionTitle}>{t('drawer.reads')}</h3>
      <p className={styles.drawerNone} title={t('drawer.readsNone')} data-testid="part-reads">
        —
      </p>

      <h3 className={drawer.sectionTitle}>{t('drawer.mayDo')}</h3>
      {failingNow && playing ? (
        <p className={styles.drawerState} data-testid="part-actions-blocked">
          {t('drawer.needsFixing', { name: playing })}
        </p>
      ) : null}
      {playing === null ? (
        <p className={styles.drawerNone} data-testid="part-actions-none">
          —
        </p>
      ) : catalogue.length > 0 ? (
        <ul className={styles.drawerActions} data-testid="part-actions">
          {catalogue.map((tool) => {
            const capability = capabilityFor(tool.slug);
            const availability = capability ? resolveAvailability(capability) : null;
            return (
              <li key={tool.slug} className={styles.drawerAction}>
                <span className={styles.drawerActionName}>
                  {sentenceCase(tool.name, integration?.name ?? null)}
                </span>
                {capability && availability && isTheAdminsChoice(availability) ? (
                  <PermissionChoice capability={capability} />
                ) : (
                  <span
                    className={styles.drawerNone}
                    data-testid={`part-action-off-${tool.slug}`}
                    title={
                      failingNow
                        ? t('drawer.needsFixing', { name: playing })
                        : availability && !isTheAdminsChoice(availability)
                          ? availability.reason === 'missing_scope' &&
                            availability.missingScopes.length > 0
                            ? tc('blocked.missingScopesNamed', {
                                scopes: availability.missingScopes.join(', '),
                              })
                            : tc(`blocked.${availability.reason}` as 'blocked.missing_scope')
                          : t('drawer.notSetUp')
                    }
                  >
                    {failingNow ? '—' : t('drawer.notSetUpShort')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : capabilities === null ? (
        <p
          className={styles.drawerNone}
          title={t('drawer.actionsUnread')}
          data-testid="part-actions-unread"
        >
          —
        </p>
      ) : actions.length === 0 ? (
        <p
          className={styles.drawerNone}
          title={t('drawer.noActions')}
          data-testid="part-actions-none"
        >
          —
        </p>
      ) : (
        <ul className={styles.drawerActions} data-testid="part-actions">
          {actions.map((capability) => {
            const availability = resolveAvailability(capability);
            return (
              <li key={capability.toolName} className={styles.drawerAction}>
                <span className={styles.drawerActionName}>
                  {hasOwnWords(capability.toolName)
                    ? tc(`tool.${capability.toolName}` as 'tool.send_message')
                    : humaniseToolName(capability.toolName)}
                </span>
                {isTheAdminsChoice(availability) ? (
                  <PermissionChoice capability={capability} />
                ) : (
                  <span
                    className={styles.drawerNone}
                    title={
                      availability.reason === 'missing_scope' &&
                      availability.missingScopes.length > 0
                        ? tc('blocked.missingScopesNamed', {
                            scopes: availability.missingScopes.join(', '),
                          })
                        : tc(`blocked.${availability.reason}` as 'blocked.missing_scope')
                    }
                  >
                    —
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <footer className={styles.drawerFootLink}>
        <Link
          href={{
            pathname: '/studio/capabilities',
            query: playingSlug ? { system: playingSlug } : {},
          }}
          className={styles.drawerLink}
        >
          {t('drawer.manage')}
        </Link>
      </footer>
    </div>
  );
}

/**
 * The catalogue names its actions in two cases ("Cancel Order", "Add order
 * note"); the product writes sentence case. Acronyms (VIP, ETA) and the
 * system's own name stay as they are.
 */
export function sentenceCase(name: string, keep: string | null): string {
  return name
    .split(' ')
    .map((word, i) => {
      if (/^[A-Z0-9]{2,}$/.test(word) || (keep !== null && word === keep)) return word;
      const lower = word.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}
