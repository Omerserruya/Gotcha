import { z } from 'zod';

/**
 * The Shopify Connector, as `GET /api/billing/shopify/state` reports it
 * (billing `serializeSnapshot`, with the split-billing fields of
 * fix/split-billing-be).
 *
 * ── TWO SUBSCRIPTIONS, NEVER ONE ──────────────────────────────────────────────
 *
 * GOTCHA Core is billed by GOTCHA and never includes Shopify. The Shopify
 * Connector is billed and managed only by Shopify. Shopify review 132211 was
 * rejected twice because our Billing page read as one set of plans, some of
 * them paid outside Shopify. Nothing here is folded into the Core plan, and
 * nothing about Core decides the Connector's verdict.
 *
 * ── ONE VERDICT, EVERY SCREEN ─────────────────────────────────────────────────
 *
 * `connectorVerdict()` is the only reading of this snapshot. The Billing
 * page's Connector section, the integration head and the rail all render from
 * it, so they cannot disagree about one store.
 *
 * ★ The UI decides nothing. `connector.status` is the server's verdict (it
 *   orders installation, uninstall, access and the billing state itself);
 *   "Shopify access" is the server's `grantsAccess`, copied; "may connect" is
 *   `core.allowsShopifyConnect`, the rule the install claim enforces. A UI
 *   that re-derived any of them from `shopify.state` would say "on" for an
 *   uninstalled store still marked TRIALING.
 *
 * ── TOLERANT ON PURPOSE ──────────────────────────────────────────────────────
 *
 * Every field `.catch()`es. A status this build has never heard of is the
 * `unknown` verdict, not a rejected response: one new enum member must not
 * blank the Billing page.
 */

/** Only an https page is somewhere to send a browser. Never built here. */
const serverUrl = z
  .string()
  .url()
  .refine((url) => new URL(url).protocol === 'https:')
  .nullable()
  .catch(null);

export const shopifyConnectorSchema = z.object({
  grantsAccess: z.boolean().catch(false),
  connector: z
    .object({
      status: z.string().nullable().catch(null),
      uninstallRequestedAt: z.string().nullable().optional().catch(null),
      /** Shopify's own page to change or cancel the plan. */
      manageUrl: serverUrl.optional().default(null),
    })
    .nullable()
    .optional()
    .catch(null),
  installation: z
    .object({ shopDomain: z.string().nullable().optional().catch(null) })
    .nullable()
    .optional()
    .catch(null),
  core: z
    .object({
      /**
       * The server's "may this workspace connect a store", computed by the
       * same function the install claim runs. Absent is unknown, and the
       * server's 402 `core_plan_required` is then the answer.
       */
      allowsShopifyConnect: z.boolean().nullable().optional().catch(null),
      connectBlockedReason: z.string().nullable().optional().catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
});
export type ShopifyConnector = z.infer<typeof shopifyConnectorSchema>;

/** What a screen draws for the Connector. */
export type ConnectorKind =
  /** The state could not be read. Nothing is claimed either way. */
  | 'unread'
  /** No store connected. */
  | 'not_installed'
  /** OAuth done, no working Connector: a plan is owed. Never "Active". */
  | 'authorized'
  | 'approval_pending'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'frozen'
  | 'cancelled'
  /** Asked Shopify to uninstall; only its signed webhook finishes it. */
  | 'uninstall_pending'
  | 'uninstalled'
  | 'error'
  /** A status this build does not know, or none sent. Said as that. */
  | 'unknown';

export type ConnectorCta =
  /** Connect a store: an in-app link to the integration screen. */
  | 'connect'
  /** Shopify's plan page, as `POST /api/billing/shopify/plan-selection` answers it. */
  | 'choose'
  /** Shopify's manage page: `connector.manageUrl`. */
  | 'manage'
  | null;

export interface ConnectorVerdict {
  readonly kind: ConnectorKind;
  /** The server's `grantsAccess`, verbatim. `null` only when nothing was read. */
  readonly grantsAccess: boolean | null;
  readonly cta: ConnectorCta;
  /** `manage`'s page, as the server sent it (`connector.manageUrl`); otherwise null. */
  readonly url: string | null;
  readonly shopDomain: string | null;
  /** `false`: Core first (the server's word). `null`: not said. */
  readonly connectAllowed: boolean | null;
  readonly connectBlockedReason: string | null;
}

const KINDS: Readonly<Record<string, ConnectorKind>> = {
  not_installed: 'not_installed',
  authorized_not_active: 'authorized',
  approval_pending: 'approval_pending',
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  frozen: 'frozen',
  cancelled: 'cancelled',
  uninstall_pending: 'uninstall_pending',
  uninstalled: 'uninstalled',
  error: 'error',
};

const CTAS: Readonly<Record<ConnectorKind, ConnectorCta>> = {
  unread: null,
  not_installed: 'connect',
  uninstalled: 'connect',
  authorized: 'choose',
  approval_pending: 'manage',
  active: 'manage',
  trialing: 'manage',
  past_due: 'manage',
  frozen: 'manage',
  cancelled: 'manage',
  uninstall_pending: null,
  error: null,
  unknown: null,
};

export function connectorVerdict(snapshot: ShopifyConnector | null): ConnectorVerdict {
  if (snapshot === null) {
    return {
      kind: 'unread',
      grantsAccess: null,
      cta: null,
      url: null,
      shopDomain: null,
      connectAllowed: null,
      connectBlockedReason: null,
    };
  }
  const status = snapshot.connector?.status ?? null;
  const named = status === null ? 'unknown' : (KINDS[status] ?? 'unknown');
  /*
    "Active" is said only with the server's grant. The server already makes
    active/trialing imply grantsAccess; a response where they disagree is
    drift, and drift reads as an error - never as a working Connector.
  */
  const kind =
    (named === 'active' || named === 'trialing') && !snapshot.grantsAccess ? 'error' : named;
  const cta = CTAS[kind];
  // `choose` asks `POST plan-selection` for its page at the press; only `manage` is a link.
  const url = cta === 'manage' ? (snapshot.connector?.manageUrl ?? null) : null;
  return {
    kind,
    grantsAccess: snapshot.grantsAccess,
    cta,
    url,
    shopDomain: snapshot.installation?.shopDomain ?? null,
    connectAllowed: snapshot.core?.allowsShopifyConnect ?? null,
    connectBlockedReason: snapshot.core?.connectBlockedReason ?? null,
  };
}

/**
 * How many of Shopify's actions can run: none without the server's grant,
 * and never a tool the server marks unusable (its Connector capability is not
 * granted). "68 actions" beside a store with no Connector was the defect.
 *
 * `usable` rides on `GET /api/integrations`' `catalogTools`
 * (fix/split-billing-be), keyed by the tool's slug - the last segment of an
 * action's `toolName` (`shopify.cancel_order` -> `cancel_order`).
 */
export function usableShopifyActions(
  verdict: ConnectorVerdict,
  actions: readonly { readonly toolName: string }[],
  catalog: readonly { readonly slug: string; readonly usable?: boolean }[] = [],
): number {
  if (verdict.grantsAccess !== true) return 0;
  const locked = new Set(catalog.filter((t) => t.usable === false).map((t) => t.slug));
  return actions.filter((a) => !locked.has(a.toolName.slice(a.toolName.lastIndexOf('.') + 1)))
    .length;
}

/** An installed store: the integration screen draws the verdict instead of "Connected". */
export function isInstalledKind(kind: ConnectorKind): boolean {
  return kind !== 'unread' && kind !== 'not_installed' && kind !== 'uninstalled';
}

/** The answer to `POST /api/integrations/shopify/uninstall`: accepted, not done. */
export const uninstallAnswerSchema = z.object({
  state: z.string(),
  shopDomain: z.string().nullable().optional(),
});
