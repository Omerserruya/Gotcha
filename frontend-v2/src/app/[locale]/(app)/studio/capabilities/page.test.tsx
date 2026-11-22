import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilitySchema } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
import { AvailableSystem } from '@/features/capabilities/AvailableSystem';
import { CapabilityScreen } from '@/features/capabilities/CapabilityScreen';
import { DisconnectSystem } from '@/features/capabilities/DisconnectSystem';
import { OAuthLanding } from '@/features/capabilities/OAuthLanding';
import { ReconnectSystem } from '@/features/capabilities/ReconnectSystem';
import { SystemHead } from '@/features/capabilities/SystemHead';
import { CustomApiTools } from '@/features/agent-tools/CustomApiTools';
import { customTool, server } from '@/features/agent-tools/fixtures';
import { McpIntro } from '@/features/agent-tools/McpIntro';
import { McpServerDetail } from '@/features/agent-tools/McpServerDetail';
import { OwnToolsRail } from '@/features/agent-tools/OwnToolsRail';
import { IntegrationRail } from '@/features/capabilities/IntegrationRail';

const loadCapabilities = vi.hoisted(() => vi.fn());
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadCapabilities,
  loadShopifyAvailability: async () => ({ mode: 'listing', helpUrl: null }),
  loadShopifyClaim: async () => null,
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}) }));
/* The business's own tools: MCP servers and Custom API, per test. */
const own = vi.hoisted(() => ({ loadMcpServers: vi.fn(), loadCustomApiTools: vi.fn() }));
vi.mock('@/features/agent-tools/load-agent-tools', () => own);
/* The Shopify Connector's snapshot - the Billing page's read - per test. */
const loadShopifyConnector = vi.hoisted(() => vi.fn());
vi.mock('@/features/billing/load-connector', () => ({ loadShopifyConnector }));

/** The detail and the rail are props of the split, not children: visit both. */
const find = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    if (node.type === type) found = node.props as T;
    const props = (
      node as ReactElement<{ children?: ReactNode; detail?: ReactNode; list?: ReactNode }>
    ).props;
    visit(props.children);
    visit(props.detail);
    visit(props.list);
  };
  visit(tree);
  return found;
};

const page = async (params: Record<string, string> = {}) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(params) });
};

const shopify = integrationSchema.parse({
  id: 'i1',
  slug: 'shopify',
  name: 'Shopify',
  tenantConnection: { id: 'c1', status: 'ERROR' },
});
const woo = integrationSchema.parse({ id: 'i2', slug: 'woocommerce', name: 'WooCommerce' });

beforeEach(() => {
  own.loadMcpServers.mockReset();
  own.loadMcpServers.mockResolvedValue([]);
  own.loadCustomApiTools.mockReset();
  own.loadCustomApiTools.mockResolvedValue([]);
  loadShopifyConnector.mockReset();
  loadShopifyConnector.mockResolvedValue(null);
  loadCapabilities.mockReset();
  loadCapabilities.mockResolvedValue({
    capabilities: [
      capabilitySchema.parse({
        toolName: 'shopify.cancel_order',
        integration: 'shopify',
        riskLevel: 'HIGH',
      }),
    ],
    usage: null,
    integrations: [shopify, woo],
  });
});

describe('★★ 10 - every integration has its own screen', () => {
  it('?system=<not connected> is that system’s screen, with Connect - not the permissions', async () => {
    const tree = await page({ system: 'woocommerce' });
    expect(find<{ integration: { slug: string } }>(tree, AvailableSystem)?.integration.slug).toBe(
      'woocommerce',
    );
    expect(find(tree, CapabilityScreen)).toBeNull();
  });

  it('?system=<connected, even broken> is its permissions', async () => {
    const tree = await page({ system: 'shopify' });
    expect(find(tree, AvailableSystem)).toBeNull();
    expect(
      find<{ capabilities: { toolName: string }[] }>(tree, CapabilityScreen)?.capabilities,
    ).toHaveLength(1);
    // Its catalogue names its rows.
    expect(
      find<{ integration: { slug: string } | null }>(tree, CapabilityScreen)?.integration?.slug,
    ).toBe('shopify');
    expect(find(tree, SystemHead)).not.toBeNull();
  });

  it('even when the permissions read failed, an available system still opens', async () => {
    loadCapabilities.mockResolvedValue({
      capabilities: null,
      usage: null,
      integrations: [shopify, woo],
    });
    expect(find(await page({ system: 'woocommerce' }), AvailableSystem)).not.toBeNull();
  });
});

describe('★★ the way back from a provider', () => {
  it.each([
    [{ system: 'shopify', connected: '1' }, 'connected'],
    [{ system: 'shopify', error: 'denied' }, 'denied'],
    [{ system: 'shopify', error: 'made_up' }, 'other'],
    // Shopify's refused install, once the backend lands it here.
    [{ system: 'shopify', error: 'invalid_request' }, 'invalid_request'],
    [{ system: 'shopify', error: 'not_configured' }, 'not_configured'],
    [{ system: 'shopify', error: 'shop_connected_elsewhere' }, 'shop_connected_elsewhere'],
    // ★ A disconnect done here (ai 9d583f03), and whether the store's chat went off with it.
    [{ system: 'shopify', disconnected: '1', chat: 'off' }, 'disconnected_chat_off'],
    [{ system: 'shopify', disconnected: '1' }, 'disconnected'],
    [{ system: 'shopify', disconnected: '0', chat: 'off' }, null],
  ])('%o → said as %s, above the system', async (params, outcome) => {
    const tree = await page(params);
    expect(find<{ outcome: string; slug: string }>(tree, OAuthLanding)).toMatchObject({
      outcome,
      slug: 'shopify',
    });
  });

  it('no return: mounted with nothing to say (it holds a sentence across the URL tidy)', async () => {
    expect(
      find<{ outcome: string | null }>(await page({ system: 'shopify' }), OAuthLanding)?.outcome,
    ).toBeNull();
  });
});

describe('★★ a broken connection has a way back on its screen', () => {
  const withHubspot = (connection: Record<string, unknown> | null) =>
    loadCapabilities.mockResolvedValue({
      capabilities: [],
      usage: null,
      integrations: [
        integrationSchema.parse({
          id: 'i1',
          slug: 'hubspot',
          name: 'HubSpot',
          tenantConnection: connection,
        }),
      ],
    });

  it('ERROR: the Reconnect card - carrying the reason when the header is not drawn', async () => {
    withHubspot({ id: 'c1', status: 'ERROR' });
    const tree = await page({ system: 'hubspot' });
    expect(find<{ showReason: boolean }>(tree, ReconnectSystem)?.showReason).toBe(true);
    expect(find(tree, AvailableSystem)).toBeNull();
  });

  it('CONNECTED: no Reconnect', async () => {
    withHubspot({ id: 'c1', status: 'CONNECTED' });
    expect(find(await page({ system: 'hubspot' }), ReconnectSystem)).toBeNull();
  });

  it('CONNECTED with no actions listed (no head): its Disconnect, for this system', async () => {
    withHubspot({ id: 'c1', status: 'CONNECTED' });
    expect(find<{ slug: string }>(await page({ system: 'hubspot' }), DisconnectSystem)?.slug).toBe(
      'hubspot',
    );
  });

  it('ERROR: its Disconnect is on the Reconnect card, so not drawn a second time below', async () => {
    withHubspot({ id: 'c1', status: 'ERROR' });
    const tree = await page({ system: 'hubspot' });
    expect(find(tree, ReconnectSystem)).not.toBeNull();
    expect(find(tree, DisconnectSystem)).toBeNull();
  });

  it.each([
    ['DISCONNECTED', { id: 'c1', status: 'DISCONNECTED' }],
    ['no row', null],
  ])('%s: its Connect, not a Reconnect', async (_, connection) => {
    withHubspot(connection);
    const tree = await page({ system: 'hubspot' });
    expect(find(tree, ReconnectSystem)).toBeNull();
    expect(find(tree, AvailableSystem)).not.toBeNull();
    expect(find(tree, DisconnectSystem)).toBeNull();
  });
});

describe('★★ Disconnect is in view on arrival - in the head, or on the Reconnect card (Omer, 2026-10-11)', () => {
  const withActions = (status: string) =>
    loadCapabilities.mockResolvedValue({
      capabilities: [capabilitySchema.parse({ toolName: 'hubspot.a', integration: 'hubspot' })],
      usage: null,
      integrations: [
        integrationSchema.parse({
          id: 'i1',
          slug: 'hubspot',
          name: 'HubSpot',
          tenantConnection: { id: 'c1', status },
        }),
      ],
    });

  it('★★ CONNECTED with actions: the head carries it, and nothing below the list', async () => {
    withActions('CONNECTED');
    const tree = await page({ system: 'hubspot' });
    expect(find<{ disconnect?: boolean }>(tree, SystemHead)?.disconnect).toBe(true);
    expect(find(tree, DisconnectSystem)).toBeNull();
  });

  it('★ ERROR with actions: the Reconnect card carries it, so the head does not', async () => {
    withActions('ERROR');
    const tree = await page({ system: 'hubspot' });
    expect(find(tree, ReconnectSystem)).not.toBeNull();
    expect(find<{ disconnect?: boolean }>(tree, SystemHead)?.disconnect).toBe(false);
    expect(find(tree, DisconnectSystem)).toBeNull();
  });
});

describe("★★ split billing (132211) - Shopify reads its Connector, the Billing page's verdict", () => {
  const connected = integrationSchema.parse({
    id: 'i1',
    slug: 'shopify',
    name: 'Shopify',
    tenantConnection: { id: 'c1', status: 'CONNECTED' },
  });
  const withShopify = (entry = connected) =>
    loadCapabilities.mockResolvedValue({
      capabilities: [
        capabilitySchema.parse({ toolName: 'shopify.cancel_order', integration: 'shopify' }),
      ],
      usage: null,
      integrations: [entry, woo],
    });

  it('the head and the rail get the verdict of the same snapshot the Billing page reads', async () => {
    const { CONNECTOR_FIXTURES } = await import('@/features/billing/connector-fixtures');
    const { IntegrationRail } = await import('@/features/capabilities/IntegrationRail');
    withShopify();
    loadShopifyConnector.mockResolvedValue(CONNECTOR_FIXTURES.plan_selection_required);
    const tree = await page({ system: 'shopify' });
    expect(loadShopifyConnector).toHaveBeenCalledOnce();
    const head = find<{ connector: { kind: string; grantsAccess: boolean } }>(tree, SystemHead);
    expect(head?.connector).toMatchObject({ kind: 'authorized', grantsAccess: false });
    const rail = find<{ shopify: { kind: string } }>(tree, IntegrationRail);
    expect(rail?.shopify).toBe(head?.connector);
  });

  it("another system open: the rail still reads Shopify's Connector, the head does not get it", async () => {
    const { IntegrationRail } = await import('@/features/capabilities/IntegrationRail');
    withShopify();
    loadCapabilities.mockResolvedValue({
      capabilities: [],
      usage: null,
      integrations: [
        connected,
        integrationSchema.parse({
          id: 'i3',
          slug: 'hubspot',
          name: 'HubSpot',
          tenantConnection: { id: 'c3', status: 'CONNECTED' },
        }),
      ],
    });
    const tree = await page({ system: 'hubspot' });
    expect(find<{ shopify: { kind: string } }>(tree, IntegrationRail)?.shopify?.kind).toBe(
      'unread',
    );
  });

  it('no Shopify in the rail: nothing is read', async () => {
    loadCapabilities.mockResolvedValue({ capabilities: [], usage: null, integrations: [woo] });
    await page({ system: 'woocommerce' });
    expect(loadShopifyConnector).not.toHaveBeenCalled();
  });

  it('Core not paid: the Connect card is told the server said no', async () => {
    const { CONNECTOR_FIXTURES } = await import('@/features/billing/connector-fixtures');
    const loose = integrationSchema.parse({ id: 'i1', slug: 'shopify', name: 'Shopify' });
    loadCapabilities.mockResolvedValue({ capabilities: [], usage: null, integrations: [loose] });
    loadShopifyConnector.mockResolvedValue(CONNECTOR_FIXTURES.core_unpaid);
    const tree = await page({ system: 'shopify' });
    expect(
      find<{ shopify: { connectAllowed: boolean | null } }>(tree, AvailableSystem)?.shopify,
    ).toEqual({ mode: 'listing', helpUrl: null, connectAllowed: false });
  });

  it('a reload during the uninstall wait opens Disconnect on the wait', async () => {
    const { CONNECTOR_FIXTURES } = await import('@/features/billing/connector-fixtures');
    withShopify();
    loadShopifyConnector.mockResolvedValue(CONNECTOR_FIXTURES.uninstall_pending);
    const tree = await page({ system: 'shopify' });
    expect(find<{ connector: { kind: string } }>(tree, SystemHead)?.connector.kind).toBe(
      'uninstall_pending',
    );
  });
});

describe("★★ the business's own tools (MCP servers, Custom API)", () => {
  const customApi = integrationSchema.parse({ id: 'i3', slug: 'custom_api', name: 'Custom API' });

  it('★ custom_api leaves the catalogue for its own rail row; the rail carries the own tools', async () => {
    loadCapabilities.mockResolvedValue({
      capabilities: [],
      usage: null,
      integrations: [shopify, woo, customApi],
    });
    own.loadMcpServers.mockResolvedValue([server()]);
    const tree = await page();
    const rail = find<{ integrations: { slug: string }[]; ownTools: ReactNode }>(
      tree,
      IntegrationRail,
    );
    expect(rail?.integrations.map((entry) => entry.slug)).toEqual(['shopify', 'woocommerce']);
    expect(find<{ servers: unknown[] }>(rail?.ownTools, OwnToolsRail)?.servers).toHaveLength(1);
  });

  it('?system=mcp is the connect screen; sent=1 says it reached GOTCHA', async () => {
    const tree = await page({ system: 'mcp', sent: '1' });
    expect(find<{ sent: boolean }>(tree, McpIntro)?.sent).toBe(true);
    expect(find(tree, CapabilityScreen)).toBeNull();
    expect(find(tree, AvailableSystem)).toBeNull();
  });

  it('?system=mcp:<id> is that server', async () => {
    own.loadMcpServers.mockResolvedValue([server()]);
    const tree = await page({ system: 'mcp:srv_1' });
    expect(find<{ server: { id: string } }>(tree, McpServerDetail)?.server.id).toBe('srv_1');
  });

  it('★ a failed read of the servers is never "not found"', async () => {
    own.loadMcpServers.mockResolvedValue(null);
    const tree = await page({ system: 'mcp:srv_1' });
    expect(find(tree, McpServerDetail)).toBeNull();
    expect(JSON.stringify(tree)).toContain('ownTools.mcp.unread');
    expect(JSON.stringify(tree)).not.toContain('ownTools.mcp.notFound');
  });

  it('?system=custom_api is the custom API tools, not the catalogue tile', async () => {
    loadCapabilities.mockResolvedValue({
      capabilities: [],
      usage: null,
      integrations: [customApi],
    });
    own.loadCustomApiTools.mockResolvedValue([customTool()]);
    const tree = await page({ system: 'custom_api' });
    expect(find<{ tools: unknown[] }>(tree, CustomApiTools)?.tools).toHaveLength(1);
    expect(find(tree, AvailableSystem)).toBeNull();
  });

  it('★ a failed custom API read says so, never an empty list', async () => {
    own.loadCustomApiTools.mockResolvedValue(null);
    const tree = await page({ system: 'custom_api' });
    expect(find(tree, CustomApiTools)).toBeNull();
    expect(JSON.stringify(tree)).toContain('ownTools.custom.unread');
  });
});
