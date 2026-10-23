import { useTranslations } from 'next-intl';

import { isFailing, type Integration } from '@/api/contracts/integrations';
import type { IntegrationSuggestion } from '@/api/contracts/onboarding-v2';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { ConnectFor, isLaunchable } from '@/features/capabilities/ConnectFor';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { Link } from '@/i18n/navigation';

import styles from './Onboarding.module.css';
import { stepHref } from './preview';

export type Standing = 'connected' | 'failing' | 'none';

/**
 * Where a system stands. A connection ROW is not a connection: an ERROR
 * row, a failed test or a stored error needs reconnecting (dev: Shopify's
 * row was ERROR and the old 00g said "Connected"). Connected is CONNECTED
 * and not failing; anything else is not connected yet.
 */
export function standingOf(integration: Integration | null): Standing {
  const connection = integration?.tenantConnection ?? null;
  if (!connection) return 'none';
  if (isFailing(connection)) return 'failing';
  return connection.status === 'CONNECTED' ? 'connected' : 'none';
}

/** The step after this one: channels. */
export const afterSystems = (preview: boolean) => stepHref('/onboarding/channels', preview);

/**
 * Step 2 - connect your systems (00g's card, once per suggestion). Only what
 * the site job suggests: the platform the site runs on, and tools it saw
 * there that GOTCHA connects to - each with WHY, and one way to connect
 * (`ConnectFor`, the same launcher as Studio · Integrations).
 *
 * ★ The why is the route's reason, never a guess: an unknown reason draws
 *   no why line. Where a tool was seen is a link to that page, never the
 *   address written out.
 * ★ Skipping is said plainly: without a store connected, GOTCHA explains the
 *   policies but can't check an order.
 */
export function SystemsStep({
  suggestions,
  integrations,
  shopify,
  preview = false,
}: {
  /** `null`: unread. */
  readonly suggestions: readonly IntegrationSuggestion[] | null;
  readonly integrations: readonly Integration[] | null;
  readonly shopify: ShopifyAvailability | null;
  /** Read-only: connecting is a write, drawn as a status. */
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.systems');
  const tn = useTranslations('onboarding');
  const tc = useTranslations('capabilities.available');
  const of = (slug: string) => integrations?.find((each) => each.slug === slug) ?? null;
  const standing = (suggestion: IntegrationSuggestion): Standing => {
    const integration = of(suggestion.slug);
    // The catalogue's row says more than the suggestion's flag (ERROR is not connected).
    if (integration) return standingOf(integration);
    return suggestion.connected ? 'connected' : 'none';
  };
  /*
   * Only what can be connected from HERE: one that can't (its sign-in returns
   * elsewhere) is not shown at all - a line under the list says more systems
   * connect later, in Settings - so an owner never meets a dead control.
   */
  const shown = (suggestions ?? []).filter((each) => {
    const integration = of(each.slug);
    const state = standing(each);
    return !integration || state === 'connected' || isLaunchable(integration, state === 'failing');
  });
  const hidden = (suggestions?.length ?? 0) - shown.length;
  const anyConnected = shown.some((each) => standing(each) === 'connected');
  const nothingToDo = suggestions !== null && shown.length === 0;
  const drawn = (integration: Integration) => ({
    connect: t('connectName', { name: integration.name }),
    oauthNotHere: tc('oauthNotHere', { name: integration.name }),
    noForm: tc('noForm'),
  });

  return (
    <div className={styles.systemsStep} data-testid="systems">
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>

      {suggestions === null ? (
        <p className={styles.why} role="alert" data-testid="systems-unread">
          {t('unread')}
        </p>
      ) : shown.length === 0 && hidden === 0 ? (
        <p className={styles.why} data-testid="systems-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className={styles.suggestions}>
          {shown.map((suggestion) => {
            const integration = of(suggestion.slug);
            const name = integration?.name || suggestion.name || suggestion.slug;
            const state = standing(suggestion);
            return (
              <li
                key={suggestion.slug}
                className={styles.system}
                data-testid={`systems-${suggestion.slug}`}
              >
                <span className={styles.systemHead}>
                  <IntegrationLogo slug={suggestion.slug} size="rail" />
                  <span className={styles.systemText}>
                    <span className={styles.systemName}>
                      <bdi dir="auto">{name}</bdi>
                    </span>
                    {suggestion.reason ? (
                      <span className={styles.quiet} data-testid={`systems-why-${suggestion.slug}`}>
                        {t.rich(`why.${suggestion.reason}`, {
                          name,
                          ltr: (chunks) => <bdi dir="auto">{chunks}</bdi>,
                        })}
                        {suggestion.evidenceUrl ? (
                          <>
                            {' '}
                            <a
                              href={suggestion.evidenceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.inlineLink}
                              data-testid={`systems-where-${suggestion.slug}`}
                            >
                              {t('where')}
                            </a>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  {state === 'connected' ? (
                    <span
                      className={styles.connected}
                      data-testid={`systems-connected-${suggestion.slug}`}
                    >
                      {t('connected')}
                    </span>
                  ) : state === 'failing' ? (
                    <span
                      className={styles.failing}
                      data-testid={`systems-failing-${suggestion.slug}`}
                    >
                      {t('failing')}
                    </span>
                  ) : null}
                </span>
                {state === 'connected' ? null : integration === null ? (
                  <p className={styles.why} data-testid={`systems-not-offered-${suggestion.slug}`}>
                    {integrations === null ? t('catalogueUnread') : t('notOffered', { name })}
                  </p>
                ) : preview ? (
                  <div
                    className={styles.connectHere}
                    data-testid={`systems-preview-${suggestion.slug}`}
                  >
                    <UnavailableAction
                      label={tc('connect')}
                      tag={tn('preview.tag')}
                      why={tn('preview.why')}
                    />
                  </div>
                ) : (
                  <div
                    className={styles.connectHere}
                    data-testid={`systems-connect-${suggestion.slug}`}
                  >
                    {state === 'failing' ? (
                      <p className={styles.why}>{t('failingWhy', { name })}</p>
                    ) : null}
                    <ConnectFor
                      integration={integration}
                      shopify={shopify}
                      reconnect={state === 'failing'}
                      drawn={drawn(integration)}
                      formLabel={t('connectName', { name })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hidden > 0 ? (
        <p className={styles.quiet} data-testid="systems-more-later">
          {t('moreLater')}
        </p>
      ) : null}

      <span className={styles.actions}>
        {/* Connecting is the step's point: skipping it is the quiet way on, never the loud one. */}
        <Link
          href={afterSystems(preview)}
          className={anyConnected || nothingToDo ? styles.primary : styles.secondary}
          data-testid="systems-next"
        >
          {anyConnected || nothingToDo ? t('next') : t('skip')}
        </Link>
      </span>
      {anyConnected || nothingToDo ? null : (
        <p className={styles.quiet} data-testid="systems-skip-why">
          {t('skipWhy')}
        </p>
      )}
    </div>
  );
}
