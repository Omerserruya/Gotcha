import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { isConnected, isFailing, type Integration } from '@/api/contracts/integrations';
import type { IntegrationSuggestion } from '@/api/contracts/onboarding-v2';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { isLaunchable } from '@/features/capabilities/ConnectFor';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { ShopifyBillingVerify, ShopifyPending } from '@/features/capabilities/ShopifyConnect';

import { connectKind, STORE_SYSTEMS } from './connect-kind';
import shell from './Onboarding.module.css';
import { stepHref } from './preview';
import { StepLink } from './StepLink';
import { SystemsConnect } from './SystemsConnect';
import { CleanReturnQuery, SystemsLanding } from './SystemsLanding';
import type { SystemsReturn } from './systems-return';
import styles from './SystemsStep.module.css';

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
 * Step 2 - connect your systems. Only what the site job suggests, and the one
 * that matters most first:
 *
 *   the platform the site runs on   the big card: what connecting gives, what
 *                                   happens (your store's admin, approve, back
 *                                   here) and one button
 *   other tools seen on the site    a quiet list under it, a smaller button each
 *   skipping                        the quiet way on, with what it costs
 *
 * Every start asks for `flow=onboarding_systems`, so the provider returns
 * HERE (`systems-return.ts`), and the step says what came of it: connected,
 * not connected with what to do next, or Shopify's store to claim / plan to
 * check - Studio · Capabilities' own components for those two.
 *
 * ★ The why is the route's reason, never a guess: an unknown reason draws
 *   no why line. Where a tool was seen is a link to that page, never the
 *   address written out.
 * ★ A system that can't be connected from here is not shown; one line says
 *   more connect later, in Settings.
 */
export function SystemsStep({
  suggestions,
  integrations,
  shopify,
  site = null,
  returned = null,
  shopifyPending = null,
  preview = false,
}: {
  /** `null`: unread. */
  readonly suggestions: readonly IntegrationSuggestion[] | null;
  readonly integrations: readonly Integration[] | null;
  readonly shopify: ShopifyAvailability | null;
  /** The site the scan read: WooCommerce's store address when it runs on WooCommerce. */
  readonly site?: string | null;
  /** The way back from a provider, read off the query. */
  readonly returned?: SystemsReturn | null;
  /** Shopify's store waiting to be claimed (`pending=1`): its domain, `gone`, or `null` unread. */
  readonly shopifyPending?: string | 'gone' | null;
  /** Read-only: connecting is a write, drawn as a status. */
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.systems');
  const tn = useTranslations('onboarding');
  const of = (slug: string) => integrations?.find((each) => each.slug === slug) ?? null;
  const standing = (suggestion: IntegrationSuggestion): Standing => {
    const integration = of(suggestion.slug);
    // The catalogue's row says more than the suggestion's flag (ERROR is not connected).
    if (integration) return standingOf(integration);
    return suggestion.connected ? 'connected' : 'none';
  };
  const shown = (suggestions ?? []).filter((each) => {
    const integration = of(each.slug);
    const state = standing(each);
    return !integration || state === 'connected' || isLaunchable(integration, state === 'failing');
  });
  const hidden = (suggestions?.length ?? 0) - shown.length;
  const anyConnected = shown.some((each) => standing(each) === 'connected');
  const nothingToDo = suggestions !== null && shown.length === 0;
  // The platform the site runs on leads; without one, the first suggestion does.
  const hero = shown.find((each) => each.reason === 'platform') ?? shown[0] ?? null;
  const others = shown.filter((each) => each !== hero);
  const nameOf = (slug: string) =>
    of(slug)?.name || suggestions?.find((each) => each.slug === slug)?.name || slug;

  /* The way back: in the card it belongs to, or above everything for one not shown. */
  const landingFor = (slug: string) =>
    returned &&
    returned.slug === slug &&
    (returned.kind === 'connected' || returned.kind === 'error') ? (
      <SystemsLanding
        slug={slug}
        name={nameOf(slug)}
        outcome={returned.kind === 'connected' ? 'connected' : returned.code}
      />
    ) : null;
  const landingShownBelow = returned !== null && shown.some((each) => each.slug === returned.slug);
  const shopifyRow = of('shopify');

  const why = (suggestion: IntegrationSuggestion, name: string) =>
    suggestion.reason ? (
      <span className={styles.why} data-testid={`systems-why-${suggestion.slug}`}>
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
              className={styles.link}
              data-testid={`systems-where-${suggestion.slug}`}
            >
              {t('where')}
            </a>
          </>
        ) : null}
      </span>
    ) : null;

  const chip = (slug: string, state: Standing) =>
    state === 'connected' ? (
      <span className={styles.connected} data-testid={`systems-connected-${slug}`}>
        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
        {t('connected')}
      </span>
    ) : state === 'failing' ? (
      <span className={styles.failing} data-testid={`systems-failing-${slug}`}>
        {t('failing')}
      </span>
    ) : null;

  /** The way to connect, or why there is none: shared by the card and the rows. */
  const connectArea = (suggestion: IntegrationSuggestion, variant: 'hero' | 'row') => {
    const integration = of(suggestion.slug);
    const name = nameOf(suggestion.slug);
    const state = standing(suggestion);
    if (state === 'connected') return null;
    if (integration === null) {
      return (
        <p className={styles.note} data-testid={`systems-not-offered-${suggestion.slug}`}>
          {integrations === null ? t('catalogueUnread', { name }) : t('notOffered', { name })}
        </p>
      );
    }
    if (preview) {
      return (
        <div data-testid={`systems-preview-${suggestion.slug}`}>
          <UnavailableAction
            label={t('connectName', { name })}
            tag={tn('preview.tag')}
            why={tn('preview.why')}
          />
        </div>
      );
    }
    return (
      <div className={styles.connectArea} data-testid={`systems-connect-${suggestion.slug}`}>
        {state === 'failing' ? <p className={styles.note}>{t('failingWhy', { name })}</p> : null}
        <SystemsConnect
          integration={integration}
          name={name}
          reconnect={state === 'failing'}
          shopify={shopify}
          // The scanned site is the store only when the site runs on WooCommerce.
          store={
            suggestion.slug === 'woocommerce' && suggestion.reason === 'platform' ? site : null
          }
          variant={variant}
        />
      </div>
    );
  };

  const heroCard = (suggestion: IntegrationSuggestion) => {
    const integration = of(suggestion.slug);
    const name = nameOf(suggestion.slug);
    const state = standing(suggestion);
    const kind = integration ? connectKind(integration, state === 'failing') : 'none';
    const isStore = STORE_SYSTEMS.includes(suggestion.slug);
    const steps =
      state === 'connected' || kind === 'form' || kind === 'none' || integration === null
        ? null
        : isStore
          ? 'store'
          : 'account';
    return (
      <section
        className={styles.hero}
        data-state={state}
        data-testid={`systems-${suggestion.slug}`}
        aria-labelledby={`systems-name-${suggestion.slug}`}
      >
        <div className={styles.heroHead}>
          <span className={styles.heroLogo}>
            <IntegrationLogo slug={suggestion.slug} size="head" />
          </span>
          <span className={styles.heroText}>
            {suggestion.reason === 'platform' ? (
              <span className={styles.eyebrow}>{t('detected')}</span>
            ) : null}
            <span className={styles.heroName} id={`systems-name-${suggestion.slug}`}>
              <bdi dir="auto">{name}</bdi>
            </span>
            {why(suggestion, name)}
          </span>
          {chip(suggestion.slug, state)}
        </div>

        {landingFor(suggestion.slug)}

        <div className={styles.gives}>
          <span className={styles.label}>{t('gives.title')}</span>
          <p className={styles.givesText} data-testid="systems-gives">
            {state === 'connected'
              ? t(isStore ? 'gives.storeOn' : 'gives.otherOn')
              : t(isStore ? 'gives.store' : 'gives.other')}
          </p>
        </div>

        {steps ? (
          <div className={styles.how}>
            <span className={styles.label}>{t('how.title')}</span>
            <ol className={styles.steps} data-testid="systems-how">
              {(['one', 'two', 'three'] as const).map((n, i) => (
                <li key={n} className={styles.stepItem}>
                  <span className={styles.stepNum} aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{t(`how.${steps}.${n}`, { name })}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {state === 'connected' ? null : (
          <div className={styles.heroFoot}>
            {connectArea(suggestion, 'hero')}
            {integration !== null && !preview ? (
              <span className={styles.safe}>{t('safe')}</span>
            ) : null}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className={styles.step} data-testid="systems">
      {returned ? <CleanReturnQuery /> : null}
      <h1 className={shell.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>

      <div className={styles.banners}>
        {returned?.kind === 'billing' ? (
          <ShopifyBillingVerify
            shop={returned.shop}
            needsReconnect={shopifyRow !== null && isConnected(shopifyRow)}
          />
        ) : null}
        {returned?.kind === 'pending' ? (
          <ShopifyPending
            pending={shopifyPending}
            replace={returned.replace}
            helpUrl={shopify?.helpUrl ?? null}
          />
        ) : null}
        {returned && !landingShownBelow ? landingFor(returned.slug) : null}
      </div>

      {suggestions === null ? (
        <p className={styles.note} role="alert" data-testid="systems-unread">
          {t('unread')}
        </p>
      ) : shown.length === 0 && hidden === 0 ? (
        <p className={styles.note} data-testid="systems-empty">
          {t('empty')}
        </p>
      ) : (
        <>
          {hero ? heroCard(hero) : null}
          {others.length > 0 ? (
            <section className={styles.others} aria-labelledby="systems-others">
              <h2 className={styles.othersTitle} id="systems-others">
                {hero?.reason === 'platform' ? t('others.title') : t('others.more')}
              </h2>
              <ul className={styles.rows}>
                {others.map((suggestion) => {
                  const name = nameOf(suggestion.slug);
                  const state = standing(suggestion);
                  return (
                    <li
                      key={suggestion.slug}
                      className={styles.row}
                      data-testid={`systems-${suggestion.slug}`}
                    >
                      <div className={styles.rowHead}>
                        <IntegrationLogo slug={suggestion.slug} size="rail" />
                        <span className={styles.rowText}>
                          <span className={styles.rowName}>
                            <bdi dir="auto">{name}</bdi>
                          </span>
                          {why(suggestion, name)}
                        </span>
                        {chip(suggestion.slug, state)}
                      </div>
                      {landingFor(suggestion.slug)}
                      {connectArea(suggestion, 'row')}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {hidden > 0 ? (
        <p className={styles.quiet} data-testid="systems-more-later">
          {t('moreLater')}
        </p>
      ) : null}

      <div className={styles.footer}>
        {/* Connecting is the step's point: skipping it is the quiet way on, never the loud one. */}
        <StepLink
          href={afterSystems(preview)}
          step="channels"
          preview={preview}
          className={anyConnected || nothingToDo ? shell.primary : styles.skip}
          data-testid="systems-next"
        >
          {anyConnected || nothingToDo ? t('next') : t('skip')}
        </StepLink>
        {anyConnected || nothingToDo ? null : (
          <p className={styles.quiet} data-testid="systems-skip-why">
            {t('skipWhy')}
          </p>
        )}
      </div>
    </div>
  );
}
