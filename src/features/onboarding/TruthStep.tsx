import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { isFailing, type Integration } from '@/api/contracts/integrations';
import { ConnectFor } from '@/features/capabilities/ConnectFor';
import { OAuthButton } from '@/features/capabilities/OAuthButton';
import { oauthHere } from '@/features/capabilities/oauth';
import { WooConnect } from '@/features/capabilities/WooConnect';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import type { ShopifyAvailability } from '@/features/capabilities/load-capabilities';
import { UnavailableTag } from '@/design-system/primitives/unavailable/Unavailable';
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

export type Standing = 'connected' | 'failing' | 'none';

/**
 * Where a system stands. A connection ROW is not a connection: an ERROR
 * row, a failed test or a stored error needs reconnecting (dev: Shopify's
 * row was ERROR, its lastError an OAuth error page, and 00g said
 * "Connected"). Connected is CONNECTED and not failing; anything else - no
 * row, or one still pending - is not connected yet.
 */
export function standingOf(integration: Integration | null): Standing {
  const connection = integration?.tenantConnection ?? null;
  if (!connection) return 'none';
  if (isFailing(connection)) return 'failing';
  return connection.status === 'CONNECTED' ? 'connected' : 'none';
}

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
  coreSystem,
}: {
  readonly integrations: readonly Integration[] | null;
  readonly shopify: ShopifyAvailability | null;
  readonly detected: { readonly slug: string; readonly host: string | null } | null;
  /** `?system=` - a tile chosen. */
  readonly system: string | null;
  /**
   * The server's own answer to "is a core system connected"
   * (`coreSystemConnected`) - the one `/complete` checks, so 00g keeps no
   * copy of its list. `null` (none, or unread): finishing says it was
   * skipped, which only waives the check.
   */
  readonly coreSystem: string | null;
}) {
  const t = useTranslations('onboarding.truth');
  const tn = useTranslations('onboarding');
  const tc = useTranslations('capabilities.available');
  const known = (slug: string | null | undefined) =>
    slug ? TRUTH_SYSTEMS.find((s) => s === slug) : undefined;
  const selected = known(system) ?? known(detected?.slug) ?? 'shopify';
  const of = (slug: string) => integrations?.find((i) => i.slug === slug) ?? null;
  const nameOf = (slug: string) => of(slug)?.name || t(`systems.${slug}`);
  const integration = of(selected);
  const standing = standingOf(integration);
  const anyConnected = (integrations ?? []).some(
    (i) => (TRUTH_SYSTEMS as readonly string[]).includes(i.slug) && standingOf(i) === 'connected',
  );
  const coreConnected = coreSystem !== null;

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
          {standing === 'connected' ? (
            <span className={styles.connected} data-testid="truth-connected">
              {t('connected')}
            </span>
          ) : standing === 'failing' ? (
            <span className={styles.failing} data-testid="truth-failing">
              {t('failing')}
            </span>
          ) : null}
        </span>
        {standing === 'connected' ? null : standing === 'failing' && integration ? (
          // Never the stored error (dev: an HTML page) - one line, in our words.
          <div className={styles.connectHere} data-testid="truth-reconnect">
            <p className={styles.why}>{t('failingWhy', { name: integration.name })}</p>
            {integration.slug === 'woocommerce' ? (
              <WooConnect name={integration.name} />
            ) : oauthHere(integration.slug, true) ? (
              <OAuthButton slug={integration.slug} name={integration.name} mode="reconnect" />
            ) : (
              <ConnectFor
                integration={integration}
                shopify={shopify}
                drawn={{
                  connect: tc('connect'),
                  oauthNotHere: tc('oauthNotHere', { name: integration.name }),
                  noForm: tc('noForm'),
                }}
              />
            )}
          </div>
        ) : integrations === null ? (
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
          const tile = standingOf(of(slug));
          return (
            <Link
              key={slug}
              href={{ pathname: '/onboarding/truth', query: { system: slug } }}
              className={styles.systemTile}
              scroll={false}
              data-testid={`truth-tile-${slug}`}
            >
              {/* The standing is a dot on the mark, so the name always shows whole (dev). */}
              <span
                className={styles.tileMark}
                data-standing={tile === 'none' ? undefined : tile}
                title={tile === 'none' ? undefined : t(tile)}
              >
                <IntegrationLogo slug={slug} size="pill" />
              </span>
              <span className={styles.tileName}>
                {t(`systems.${slug}`)}
                {tile === 'none' ? null : (
                  <span className={styles.srOnly} data-testid={`truth-tile-standing-${slug}`}>
                    {` · ${t(tile)}`}
                  </span>
                )}
              </span>
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
            {/* Set once live (tool permissions answer only ACTIVE): a status, not choices. */}
            <UnavailableTag label={tn('notYet')} />
          </div>
        ))}
        <p className={styles.mayWhy} data-testid="truth-may-why">
          {t('may.why')}
        </p>
      </section>

      <span className={styles.actions}>
        <Link
          // Skipped: the finish says so to the route (`skipCoreSystem`), and only then.
          href={
            coreConnected
              ? '/onboarding/try'
              : { pathname: '/onboarding/try', query: { skipped: '1' } }
          }
          className={styles.primary}
          data-testid="truth-next"
        >
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
