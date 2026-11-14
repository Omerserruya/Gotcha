import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_FIXTURE_URLS,
  CONNECTOR_FIXTURES,
  type ConnectorFixture,
} from './connector-fixtures';

import {
  connectorVerdict,
  isInstalledKind,
  shopifyConnectorSchema,
  type ConnectorCta,
  type ConnectorKind,
} from '@/api/contracts/shopify-connector';

/** Every fixture, and what the one verdict must say about it. */
const EXPECTED: Record<
  ConnectorFixture,
  { kind: ConnectorKind; cta: ConnectorCta; grantsAccess: boolean; url: string | null }
> = {
  core_only: { kind: 'not_installed', cta: 'connect', grantsAccess: false, url: null },
  core_unpaid: { kind: 'not_installed', cta: 'connect', grantsAccess: false, url: null },
  plan_selection_required: { kind: 'authorized', cta: 'choose', grantsAccess: false, url: null },
  approval_pending: {
    kind: 'approval_pending',
    cta: 'manage',
    grantsAccess: false,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  active: { kind: 'active', cta: 'manage', grantsAccess: true, url: CONNECTOR_FIXTURE_URLS.manage },
  trialing: {
    kind: 'trialing',
    cta: 'manage',
    grantsAccess: true,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  both_active: {
    kind: 'active',
    cta: 'manage',
    grantsAccess: true,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  past_due: {
    kind: 'past_due',
    cta: 'manage',
    grantsAccess: false,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  frozen: {
    kind: 'frozen',
    cta: 'manage',
    grantsAccess: false,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  cancelled: {
    kind: 'cancelled',
    cta: 'manage',
    grantsAccess: false,
    url: CONNECTOR_FIXTURE_URLS.manage,
  },
  unknown_plan: { kind: 'error', cta: null, grantsAccess: false, url: null },
  error: { kind: 'error', cta: null, grantsAccess: false, url: null },
  uninstall_pending: { kind: 'uninstall_pending', cta: null, grantsAccess: false, url: null },
  uninstalled: { kind: 'uninstalled', cta: 'connect', grantsAccess: false, url: null },
};

describe('connectorVerdict - one reading of the Connector for every screen', () => {
  it.each(Object.keys(EXPECTED) as ConnectorFixture[])('%s', (name) => {
    const verdict = connectorVerdict(shopifyConnectorSchema.parse(CONNECTOR_FIXTURES[name]));
    const want = EXPECTED[name];
    expect({
      kind: verdict.kind,
      cta: verdict.cta,
      grantsAccess: verdict.grantsAccess,
      url: verdict.url,
    }).toEqual(want);
  });

  it('"Shopify access" is the server grantsAccess verbatim, whatever the status says', () => {
    for (const name of Object.keys(CONNECTOR_FIXTURES) as ConnectorFixture[]) {
      const snapshot = CONNECTOR_FIXTURES[name];
      expect(connectorVerdict(snapshot).grantsAccess).toBe(snapshot.grantsAccess);
    }
  });

  it('active or trialing without the grant is an error, never "Active" (drift on our side)', () => {
    for (const status of ['active', 'trialing']) {
      const v = connectorVerdict({
        ...CONNECTOR_FIXTURES.active,
        grantsAccess: false,
        connector: { status, uninstallRequestedAt: null, manageUrl: CONNECTOR_FIXTURE_URLS.manage },
      });
      expect(v.kind).toBe('error');
      expect(v.grantsAccess).toBe(false);
      expect(v.cta).toBeNull();
    }
  });

  it('a status this build does not know is "unknown", not a rejected response', () => {
    const parsed = shopifyConnectorSchema.parse({
      grantsAccess: false,
      connector: { status: 'paused_by_shopify', manageUrl: CONNECTOR_FIXTURE_URLS.manage },
    });
    const verdict = connectorVerdict(parsed);
    expect(verdict.kind).toBe('unknown');
    // Nothing to press on a state we cannot name.
    expect(verdict.cta).toBeNull();
    expect(verdict.url).toBeNull();
  });

  it('the manage page is offered only where the verdict is "manage", even when the server sent it', () => {
    for (const status of ['authorized_not_active', 'error', 'uninstall_pending', 'uninstalled']) {
      const verdict = connectorVerdict({
        grantsAccess: false,
        connector: { status, uninstallRequestedAt: null, manageUrl: CONNECTOR_FIXTURE_URLS.manage },
      });
      expect(verdict.cta).not.toBe('manage');
      expect(verdict.url).toBeNull();
    }
  });

  it('no connector.status at all (a server without split billing) is "unknown", never derived here', () => {
    const parsed = shopifyConnectorSchema.parse({
      grantsAccess: false,
      shopify: { state: 'ACTIVE' },
      installation: { status: 'CONNECTED', shopDomain: 'a.myshopify.com' },
    });
    const verdict = connectorVerdict(parsed);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.grantsAccess).toBe(false);
  });

  it('a failed read claims nothing either way', () => {
    expect(connectorVerdict(null)).toEqual({
      kind: 'unread',
      grantsAccess: null,
      cta: null,
      url: null,
      shopDomain: null,
      connectAllowed: null,
      connectBlockedReason: null,
    });
  });

  it('may-connect is the server allowsShopifyConnect, with its reason; absent is unknown', () => {
    expect(connectorVerdict(CONNECTOR_FIXTURES.core_only).connectAllowed).toBe(true);
    const unpaid = connectorVerdict(CONNECTOR_FIXTURES.core_unpaid);
    expect(unpaid.connectAllowed).toBe(false);
    expect(unpaid.connectBlockedReason).toBe('payment_required');
    expect(
      connectorVerdict(shopifyConnectorSchema.parse({ connector: { status: 'not_installed' } }))
        .connectAllowed,
    ).toBeNull();
  });

  it('only an https page the server sent is a manage link', () => {
    const parsed = shopifyConnectorSchema.parse({
      grantsAccess: true,
      connector: { status: 'active', manageUrl: 'http://admin.shopify.com/x' },
    });
    expect(connectorVerdict(parsed).url).toBeNull();
  });

  it('the integration screen draws the verdict for every installed kind', () => {
    expect(isInstalledKind('authorized')).toBe(true);
    expect(isInstalledKind('uninstall_pending')).toBe(true);
    expect(isInstalledKind('not_installed')).toBe(false);
    expect(isInstalledKind('uninstalled')).toBe(false);
    expect(isInstalledKind('unread')).toBe(false);
  });
});
