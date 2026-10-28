import type { ShopifyConnector } from '@/api/contracts/shopify-connector';

/**
 * Every Connector state the split-billing screens must agree on, as the
 * server would send it (fix/split-billing-be's rules: `connector.status` is
 * derived there, `grantsAccess` only with ACTIVE/TRIALING and every required
 * entitlement row, `manageUrl` for the subscribed states).
 *
 * One table, read by the state-matrix tests, the fixture screenshots and the
 * e2e capture switch (`connector-capture.ts`). A fixture is a claim that the
 * server can produce it: each row names the billing state it stands for.
 */

const SHOP = 'urban-supply-demo.myshopify.com';
const MANAGE = `https://admin.shopify.com/store/urban-supply-demo/charges/gotcha/pricing_plans`;
/** What `POST plan-selection` answers in the tests: Shopify's page, never built here. */
const CHOOSE = `https://admin.shopify.com/store/urban-supply-demo/charges/gotcha/pricing_plans?select=1`;

function snapshot(
  status: string,
  {
    grantsAccess = false,
    manage = false,
    installed = true,
    allows = true,
    blocked = null,
  }: {
    grantsAccess?: boolean;
    manage?: boolean;
    installed?: boolean;
    allows?: boolean | null;
    blocked?: string | null;
  } = {},
): ShopifyConnector {
  return {
    grantsAccess,
    connector: {
      status,
      uninstallRequestedAt: status === 'uninstall_pending' ? '2026-10-28T09:00:00Z' : null,
      manageUrl: manage ? MANAGE : null,
    },
    installation: { shopDomain: installed ? SHOP : null },
    core: { allowsShopifyConnect: allows, connectBlockedReason: blocked },
  };
}

export const CONNECTOR_FIXTURES = {
  /** Core paid, no store connected. */
  core_only: snapshot('not_installed', { installed: false }),
  /** No store, and Core not paid: connecting must wait. */
  core_unpaid: snapshot('not_installed', {
    installed: false,
    allows: false,
    blocked: 'payment_required',
  }),
  /** OAuth done, PLAN_SELECTION_REQUIRED. */
  plan_selection_required: snapshot('authorized_not_active'),
  approval_pending: snapshot('approval_pending', { manage: true }),
  active: snapshot('active', { grantsAccess: true, manage: true }),
  trialing: snapshot('trialing', { grantsAccess: true, manage: true }),
  /** Core and the Connector both active (Core's half is the Billing page's own read). */
  both_active: snapshot('active', { grantsAccess: true, manage: true }),
  past_due: snapshot('past_due', { manage: true }),
  frozen: snapshot('frozen', { manage: true }),
  cancelled: snapshot('cancelled', { manage: true }),
  /** UNKNOWN_PLAN: Shopify says active, our catalog cannot say what it funds. */
  unknown_plan: snapshot('error'),
  error: snapshot('error'),
  uninstall_pending: snapshot('uninstall_pending'),
  uninstalled: snapshot('uninstalled', { installed: false }),
} as const satisfies Record<string, ShopifyConnector>;

export type ConnectorFixture = keyof typeof CONNECTOR_FIXTURES;

export const CONNECTOR_FIXTURE_URLS = { manage: MANAGE, choose: CHOOSE } as const;
