/**
 * Where a link to the OLD app lands in this one (2026-10-21).
 *
 * This app replaced the legacy frontend at the domain root, and links to the
 * legacy app are already out there: emails, in-app notifications stored in
 * the database, bookmarks, OAuth returns in flight, and the WooCommerce
 * plugin installed on merchants' sites (its `/v2/...` links can never be
 * re-sent). Every one of them must land on the screen it meant, never a 404.
 *
 * Pure: a path and query in, a target out (or `null`: not a legacy URL, let
 * the request through). The proxy calls it BEFORE the auth gate, so a
 * signed-out visitor's `returnTo` is the new path, not the old one.
 *
 * ── THE LOCALE ──
 * Legacy URLs carry none; the old app kept it in a `locale` cookie (he|en,
 * Path=/), which survives the move. The target is prefixed with this app's
 * `NEXT_LOCALE` cookie, else that legacy cookie; with neither it stays
 * unprefixed and next-intl negotiates (Accept-Language, then the default),
 * one more hop but the same rule as everywhere else.
 *
 * ── THE TABLE ──
 * Built from the legacy app's own pages (frontend/src/app, 115 of them) and
 * the links the platform emits (services/notifications templates.ts, the
 * auth emails, the OAuth returns). `legacy-redirect.test.ts` walks the legacy
 * page tree and requires a rule for every page, so none is forgotten.
 * Where the new app has no equivalent, the nearest screen; where an id has no
 * equivalent screen, the list. Marketing pages go to the marketing site.
 */
import { isLocale, type Locale } from './locales';

const MARKETING = 'https://gotcha.co.il';
const HELP = 'https://help.gotcha.co.il';

/** Where to send it: a path in this app (unprefixed) or an absolute URL elsewhere. */
type Target =
  { readonly path: string; readonly query?: URLSearchParams } | { readonly url: string };

type Rule = readonly [RegExp, (match: RegExpExecArray, query: URLSearchParams) => Target];

/** The same query, with `from` renamed to `to` (the value kept), `drop` removed. */
function renamed(query: URLSearchParams, from: string, to: string, drop: readonly string[] = []) {
  const out = new URLSearchParams();
  for (const [key, value] of query) {
    if (drop.includes(key)) continue;
    out.append(key === from ? to : key, value);
  }
  return out;
}

const keep =
  (path: string) =>
  (_: RegExpExecArray, query: URLSearchParams): Target => ({ path, query });
const bare = (path: string) => (): Target => ({ path });
const marketing = (match: RegExpExecArray, query: URLSearchParams): Target => ({
  url: `${MARKETING}${match[0]}${query.size ? `?${query}` : ''}`,
});

/** First match wins: specific before general. Paths are matched without a trailing slash. */
const RULES: readonly Rule[] = [
  // ── the workspace ──
  [/^\/(dashboard|getting-started)?$/, bare('/home')],
  [
    /^\/conversations\/([^/]+)$/,
    (m) => ({ path: '/inbox', query: new URLSearchParams({ c: m[1]! }) }),
  ],
  [/^\/(conversations|history)$/, (_, q) => ({ path: '/inbox', query: renamed(q, 'id', 'c') })],
  [/^\/contacts$/, keep('/customers')],
  [/^\/contacts\/([^/]+)$/, (m, q) => ({ path: `/customers/${m[1]}`, query: q })],
  [/^\/approvals$/, keep('/approvals')],
  [/^\/analytics$/, keep('/analytics')],
  [/^\/(usage|settings\/usage)$/, bare('/settings/billing')],

  // ── outreach ──
  [/^\/outbound\/templates$/, keep('/outreach/templates')],
  [/^\/outbound\/call$/, keep('/outreach/calls')],
  [/^\/voice\/[^/]+(\/replay)?$/, bare('/outreach/calls')],
  [/^\/outbound(\/(broadcasts|campaigns|scheduled))?$/, keep('/outreach')],

  // ── studio ──
  [/^\/ai-studio\/agents\/new$/, bare('/studio/employees')],
  [/^\/ai-studio\/agents\/([^/]+)$/, (m) => ({ path: `/studio/employees/${m[1]}` })],
  // A flow id is not known to be an automation id: the list.
  [/^\/(ai-studio\/flows\/[^/]+|ai-studio\/router|bot)$/, bare('/studio/automations')],
  [/^\/(knowledge|business|settings\/business|ai-studio\/knowledge)$/, keep('/studio/knowledge')],
  [/^\/ai-studio$/, bare('/studio')],
  [
    /^\/integrations\/shopify\/billing\/complete$/,
    (_, q) => ({
      path: '/studio/capabilities',
      query: new URLSearchParams([['system', 'shopify'], ['billing', 'verify'], ...q]),
    }),
  ],
  [
    /^\/settings\/business-systems\/shopify\/finish$/,
    () => ({
      path: '/studio/capabilities',
      query: new URLSearchParams({ system: 'shopify', pending: '1', reason: 'claim' }),
    }),
  ],
  [
    /^\/(?:integrations|ai-studio\/marketplace)\/([^/]+)$/,
    (m, q) => {
      const query = new URLSearchParams({ system: m[1]! });
      if (
        q.get('status') === 'connected' ||
        q.has('connected') ||
        q.get('calendar') === 'connected'
      ) {
        query.set('connected', '1');
      }
      const error = q.get('error');
      if (error) query.set('error', error);
      return { path: '/studio/capabilities', query };
    },
  ],
  [/^\/(integrations|settings\/(tools|policy|business-rules))$/, keep('/studio/capabilities')],
  [/^\/(copilot|departments\/[^/]+\/copilot|settings\/voice-copilot)$/, bare('/home')],

  // ── settings ──
  [/^\/(channels|settings\/channels)$/, keep('/settings/channels')],
  [/^\/settings\/channels\/whatsapp$/, keep('/settings/channels/whatsapp')],
  [
    /^\/settings\/(channels\/(twilio|shopify-live-chat)|voice-channels(\/.*)?)$/,
    bare('/settings/channels'),
  ],
  [/^\/settings\/permissions$/, bare('/settings/people/permissions')],
  [
    /^\/(agents|departments|settings\/(people|users|agents|departments))$/,
    keep('/settings/people'),
  ],
  [/^\/(account|settings\/account)$/, bare('/settings/security')],
  [/^\/settings\/(security|notifications)$/, (m, q) => ({ path: `/settings/${m[1]}`, query: q })],
  [
    /^\/settings\/billing\/(plan|payment-method)$/,
    (m, q) => ({ path: `/settings/billing/${m[1]}`, query: q }),
  ],
  // Credits, buying them and the receipt details are all on the billing page here.
  [/^\/settings\/billing(\/(details|usage-limit|credits))?$/, keep('/settings/billing')],
  [/^\/settings\/(business-systems|integrations)(\/[^/]+)?$/, keep('/settings/systems')],
  [
    /^\/settings\/(intelligence|intelligence-fields|intelligence-reviews|post-conversation|funnels(\/[^/]+)?)$/,
    bare('/settings/workspace'),
  ],
  [/^\/settings$/, bare('/settings')],

  // ── signed out ──
  [
    /^\/login$/,
    (_, q) => ({
      path: '/sign-in',
      query: renamed(renamed(q, 'next', 'returnTo'), 'redirect', 'returnTo', ['error']),
    }),
  ],
  [/^\/auth\/callback$/, () => ({ url: '/api/auth/login' })],
  [/^\/auth\/flow-done$/, bare('/home')],
  [/^\/setup$/, bare('/onboarding')],
  // Ported to this app with the same paths and queries (2026-10-21).
  [
    /^\/(join|account\/verify-email|setup-link\/expired|checkout(\/[a-z-]+)?)$/,
    (m, q) => ({ path: m[0], query: q }),
  ],

  // ── the console ──
  // Tenants and coupons are ported (2026-10-21); the rest of the old console lands on its home.
  [/^\/system\/(tenants(\/[^/]+)?|coupons)$/, (m, q) => ({ path: m[0], query: q })],
  [/^\/system(\/.*)?$/, bare('/system')],

  // ── the marketing site ──
  [/^\/(pricing|early-access|privacy-policy|terms|legal(\/[^/]+)?)$/, marketing],
  [/^\/help(\/.*)?$/, (m) => ({ url: `${HELP}${m[1] ?? '/'}` })],
];

/** Which locale prefix a legacy URL lands on, if the visitor has told us one. */
export function legacyLocale(cookies: {
  get: (name: string) => { value: string } | undefined;
}): Locale | null {
  for (const name of ['NEXT_LOCALE', 'locale']) {
    const value = cookies.get(name)?.value;
    if (isLocale(value)) return value;
  }
  return null;
}

/**
 * The target for a legacy URL, as a path-with-query relative to the app root
 * (locale-prefixed when known) or an absolute URL; `null` when the URL is not
 * a legacy one.
 */
export function legacyRedirect(url: URL, locale: Locale | null): string | null {
  let path = url.pathname.replace(/\/+$/, '') || '/';
  // The /v2 era: links that carried the old base path (the WooCommerce plugin forever).
  const v2 = /^\/v2(\/.*)?$/.exec(path);
  if (v2) {
    const rest = v2[1] ?? '/';
    // A /v2 path already in this app's shape needs only the prefix gone.
    if (/^\/[a-z]{2}(\/|$)/.test(rest)) return `${rest}${url.search}`;
    path = rest.replace(/\/+$/, '') || '/';
    if (!RULES.some(([pattern]) => pattern.test(path))) {
      return `${locale ? `/${locale}` : ''}${rest === '/' ? '' : rest}${url.search}` || '/';
    }
  }
  // A path already in this app's shape (/en/..., /he/...) matches no rule: every
  // rule is anchored to a legacy path. The tests pin that.
  for (const [pattern, to] of RULES) {
    const match = pattern.exec(path);
    if (!match) continue;
    const target = to(match, new URLSearchParams(url.search));
    if ('url' in target) return target.url;
    const search = target.query?.size ? `?${target.query}` : '';
    const href = `${locale ? `/${locale}` : ''}${target.path}${search}`;
    /*
     * ★★ With no locale known, a rule that keeps the path (/join, /approvals,
     * /settings...) would answer the request with itself: a redirect loop
     * for every visitor without a language cookie. That is not a legacy hop -
     * it is next-intl's to negotiate. (A query this table re-encodes
     * converges: the second request reads back the same.)
     */
    if (href === `${url.pathname}${url.search}`) return null;
    return href;
  }
  return null;
}
