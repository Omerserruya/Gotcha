import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { isConnected, type Integration } from '@/api/contracts/integrations';
import { ConnectFor } from '@/features/capabilities/ConnectFor';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { Link } from '@/i18n/navigation';

import styles from './Onboarding.module.css';

/** 00g's systems, the design's order: the store platforms, then the rest. */
export const TRUTH_SYSTEMS = [
  'shopify',
  'woocommerce',
  'priority',
  'wix',
  'google_sheets',
  'custom_api',
] as const;

/** 00g's write actions - what GOTCHA may change in the store. */
const ACTIONS = ['address', 'cancel', 'refund', 'prices'] as const;
const STANCES = ['allowed', 'ask', 'never'] as const;

/**
 * 00g - Source of truth (design 6). One system in the card - the one the
 * website read found, else Shopify, or the tile chosen (`?system=`) - and
 * the rest as tiles. It connects the way 10 connects (`ConnectFor`, one
 * place): at the provider, or by the store's address; and the way back is
 * Studio · Integrations, where 10's flow returns - onboarding has no flow of
 * its own on the backend yet.
 *
 * ★ "What GOTCHA may do there" is drawn, with its reason: the per-action
 *   permissions are set where they live (Studio · Integrations), and that
 *   route answers only a live workspace.
 * ★ Skipping is said plainly: without it GOTCHA explains, it does not check.
 */
export function TruthStep({
  integrations,
  shopify,
  detected,
  system,
}: {
  readonly integrations: readonly Integration[] | null;
  readonly shopify: ShopifyAvailability | null;
  readonly detected: { readonly slug: string; readonly host: string | null } | null;
  /** `?system=` - a tile chosen. */
  readonly system: string | null;
}) {
  const t = useTranslations('onboarding.truth');
  const tc = useTranslations('capabilities.available');
  const known = (slug: string | null | undefined) =>
    slug ? TRUTH_SYSTEMS.find((s) => s === slug) : undefined;
  const selected = known(system) ?? known(detected?.slug) ?? 'shopify';
  const of = (slug: string) => integrations?.find((i) => i.slug === slug) ?? null;
  const nameOf = (slug: string) => of(slug)?.name || t(`systems.${slug}`);
  const integration = of(selected);
  const connected = integration !== null && isConnected(integration);
  const anyConnected = (integrations ?? []).some(
    (i) => (TRUTH_SYSTEMS as readonly string[]).includes(i.slug) && isConnected(i),
  );

  return (
    <div className={styles.truth}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>

      <section className={styles.system} data-testid="truth-card">
        <span className={styles.systemHead}>
          <IntegrationLogo slug={selected} size="rail" />
          <span className={styles.systemText}>
            <span className={styles.systemName}>
              {nameOf(selected)}
              {detected && detected.slug === selected && detected.host ? (
                <span className={styles.foundOn} data-testid="truth-found">
                  {t.rich('foundOn', { host: () => <bdi dir="ltr">{detected.host}</bdi> })}
                </span>
              ) : null}
            </span>
            <span className={styles.quiet}>{t(`how.${selected}`)}</span>
          </span>
          {connected ? (
            <span className={styles.connected} data-testid="truth-connected">
              {t('connected')}
            </span>
          ) : null}
        </span>
        {connected ? null : integrations === null ? (
          <p className={styles.why} data-testid="truth-unread">
            {t('unread')}
          </p>
        ) : integration === null ? (
          <p className={styles.why} data-testid="truth-not-offered">
            {t('notOffered', { name: nameOf(selected) })}
          </p>
        ) : (
          <div className={styles.connectHere} data-testid="truth-connect">
            <ConnectFor
              integration={integration}
              shopify={shopify}
              drawn={{
                connect: tc('connect'),
                oauthNotHere: tc('oauthNotHere', { name: integration.name }),
                noForm: tc('noForm'),
              }}
            />
            <p className={styles.quiet}>{t('comesBack', { name: integration.name })}</p>
          </div>
        )}
      </section>

      <nav className={styles.systems} aria-label={t('others')}>
        {TRUTH_SYSTEMS.filter((slug) => slug !== selected).map((slug) => {
          const entry = of(slug);
          return (
            <Link
              key={slug}
              href={{ pathname: '/onboarding/truth', query: { system: slug } }}
              className={styles.systemTile}
              scroll={false}
              data-testid={`truth-tile-${slug}`}
            >
              <IntegrationLogo slug={slug} size="pill" />
              <span>{nameOf(slug)}</span>
              {entry && isConnected(entry) ? (
                <span className={styles.connected}>{t('connected')}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <section className={styles.may} aria-labelledby="truth-may" data-testid="truth-may">
        <h2 className={styles.mayTitle} id="truth-may">
          {t('may.title')}
        </h2>
        <div className={styles.mayRow}>
          <span>{t('may.read')}</span>
          <span className={styles.always}>
            <Lock size={11} aria-hidden="true" />
            {t('may.always')}
          </span>
        </div>
        {ACTIONS.map((action) => (
          <div key={action} className={styles.mayRow}>
            <span>{t(`may.actions.${action}`)}</span>
            <span className={styles.stances} aria-label={t(`may.actions.${action}`)}>
              {STANCES.map((stance) => (
                <button
                  key={stance}
                  type="button"
                  className={styles.stance}
                  disabled
                  title={t('may.why')}
                >
                  {t(`may.stances.${stance}`)}
                </button>
              ))}
            </span>
          </div>
        ))}
        <p className={styles.mayWhy} data-testid="truth-may-why">
          {t('may.why')}
        </p>
      </section>

      <span className={styles.actions}>
        <Link href="/onboarding/try" className={styles.primary} data-testid="truth-next">
          {anyConnected ? t('next') : t('skip')}
        </Link>
      </span>
      {anyConnected ? null : (
        <p className={styles.quiet} data-testid="truth-skip-why">
          {t('skipWhy')}
        </p>
      )}
    </div>
  );
}
