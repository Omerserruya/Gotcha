import { integrationSchema } from '@/api/contracts/integrations';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import { EmployeeDetail } from '@/features/employees/EmployeeDetail';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import { HireSheet } from '@/features/employees/hire/HireSheet';
import { HiredDialog } from '@/features/employees/hired/HiredDialog';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';

const loadEmployees = vi.hoisted(() => vi.fn());
const loadReachability = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ channel: string; reach: string; accounts?: unknown[] }[] | null> => null,
  ),
);
vi.mock('@/features/employees/load-employees', () => ({
  loadEmployees,
  loadReachability,
}));
const caps = vi.hoisted(() => ({ value: [] as unknown[], integrations: [] as unknown[] }));
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadCapabilities: async () => ({
    capabilities: caps.value,
    usage: null,
    integrations: caps.integrations,
  }),
}));
const tools = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/features/skills/skill-actions', () => ({ readTools: async () => tools.value }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('server-only', () => ({}));
/* E5: the selected employee's levels - the card's "may do". */
const employeeTools = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/features/employees/page/load-employee-tools', () => ({
  loadEmployeeTools: async () => employeeTools.value,
}));
const { loadChannels, loadEmployeeKnowledge, loadHireSkills, loadHireFunnels } = vi.hoisted(() => ({
  loadHireFunnels: vi.fn(async () => ({
    funnels: [{ id: 'f1', name: 'B2b sales' }],
    templates: 'forbidden' as const,
  })),
  loadChannels: vi.fn(async () => ({
    channels: [
      { channel: 'WHATSAPP', connectionStatus: 'CONNECTED' },
      { channel: 'EMAIL', connectionStatus: 'ERROR' },
    ],
  })),
  loadEmployeeKnowledge: vi.fn(async () => [{ id: 'k1', name: 'Returns policy' }]),
  loadHireSkills: vi.fn(async () => [{ id: 's1', name: 'Refunds' }]),
}));
vi.mock('@/features/channels/load-channels', () => ({ loadChannels }));
vi.mock('@/features/employees/page/load-employee-knowledge', () => ({ loadEmployeeKnowledge }));
vi.mock('@/features/employees/hire/load-hire-skills', () => ({ loadHireSkills }));
vi.mock('@/features/employees/hire/load-hire-funnels', () => ({ loadHireFunnels }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const employee = (id: string, status = 'ACTIVE') =>
  employeeSchema.parse({ id, name: `Employee ${id}`, status });

function find<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, ReactNode>>;
  if (element.type === type) return element.props as P;
  for (const value of Object.values(element.props ?? {})) {
    const hit = find<P>(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

/** Every component and test id in the tree, by name. */
function names(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(names);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, ReactNode>>;
  const own =
    typeof element.type === 'function'
      ? [element.type.name]
      : [String(element.props['data-testid'] ?? '')].filter(Boolean);
  return [...own, ...Object.values(element.props ?? {}).flatMap((v) => names(v as ReactNode))];
}

const page = async (employees: unknown, query: Record<string, string> = {}) => {
  loadEmployees.mockResolvedValue(employees);
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(query) });
};

describe('★★ 07 is 02’s screen - header, then the list beside the selected one', () => {
  it('a screen page, flush, with the hire action in the header', async () => {
    const tree = (await page([employee('a')])) as ReactElement<{
      layout: string;
      flush: boolean;
      actions: ReactNode;
    }>;
    expect(tree.type).toBe(PageContainer);
    expect(tree.props).toMatchObject({ layout: 'screen', flush: true });
    expect(isValidElement(tree.props.actions)).toBe(true);
  });

  it('★ the selected employee is the one asked for; the detail holds only it', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'b' });
    expect(find<{ selectedId: string }>(tree, EmployeeRail)?.selectedId).toBe('b');
    expect(find<{ employee: { id: string } }>(tree, EmployeeDetail)?.employee.id).toBe('b');
  });

  it('an unknown id falls back to the first - never an empty detail', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'gone' });
    expect(find<{ selectedId: string }>(tree, EmployeeRail)?.selectedId).toBe('a');
  });

  it('none, or a failed read: the frame is still drawn, the state in the detail', async () => {
    for (const read of [[], null]) {
      const tree = await page(read);
      const split = find<{ list: ReactNode; detail: ReactElement }>(tree, StudioSplit);
      expect(split).not.toBeNull();
      expect(split!.list).toBeNull();
      expect((split!.detail.props as { 'data-testid': string })['data-testid']).toBe(
        read === null ? 'employees-unavailable' : 'employees-empty',
      );
    }
  });
});

describe('★ 07b - Hire opens the sheet; its reads only then', () => {
  it('without ?hire, no sheet and no extra reads', async () => {
    loadChannels.mockClear();
    loadEmployeeKnowledge.mockClear();
    loadHireSkills.mockClear();
    loadHireFunnels.mockClear();
    const tree = await page([employee('a')]);
    expect(find(tree, HireSheet)).toBeNull();
    expect(loadChannels).not.toHaveBeenCalled();
    expect(loadEmployeeKnowledge).not.toHaveBeenCalled();
    expect(loadHireSkills).not.toHaveBeenCalled();
    expect(loadHireFunnels).not.toHaveBeenCalled();
  });

  it("?hire=1&step=2: the sheet at step 2, and no channels - where it works is not the hire flow's", async () => {
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ initialStep: number; knowledge: unknown[]; skills: unknown[] }>(
      tree,
      HireSheet,
    );
    expect(props?.initialStep).toBe(2);
    expect(props).not.toHaveProperty('channels');
    // H4: the knowledge bases with their scope, and the skills it may carry.
    expect(props?.knowledge).toEqual([{ id: 'k1', name: 'Returns policy' }]);
    expect(props?.skills).toEqual([{ id: 's1', name: 'Refunds' }]);
    // H8c: the sales funnels, read only while hiring.
    expect((props as { funnels?: unknown })?.funnels).toEqual([{ id: 'f1', name: 'B2b sales' }]);
    expect((props as { templates?: unknown })?.templates).toBe('forbidden');
  });

  it('★ H4: ?step=4 is the summary', async () => {
    const tree = await page([employee('a')], { hire: '1', step: '4' });
    expect(find<{ initialStep: number }>(tree, HireSheet)?.initialStep).toBe(4);
  });

  it('★★ the hire offers only CONNECTED systems (dev: a disconnected Shopify in the summary)', async () => {
    const system = (slug: string, status: string | null) =>
      integrationSchema.parse({
        id: slug,
        slug,
        name: slug,
        tenantConnection: status === null ? null : { id: `c-${slug}`, status },
      });
    caps.integrations = [
      system('shopify', 'DISCONNECTED'),
      system('woocommerce', 'CONNECTED'),
      system('hubspot', 'ERROR'),
      system('airtable', 'PENDING'),
      system('zendesk', null),
    ];
    const tree = await page([employee('a')], { hire: '1', step: '4' });
    const props = find<{ systems: { slug: string }[] | null }>(tree, HireSheet);
    expect(props?.systems?.map((s) => s.slug)).toEqual(['woocommerce']);
    caps.integrations = [];
  });
});

describe('★ 07e - the dialog, by query; no edit sheet', () => {
  it('no dialog without its query', async () => {
    const tree = await page([employee('a')]);
    expect(find(tree, HiredDialog)).toBeNull();
  });

  it('★★ an old ?edit=1 address opens nothing over 07 - editing is the employee’s page', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'b', edit: '1' });
    const drawn = names(tree);
    expect(drawn).toContain('EmployeeDetail');
    expect(drawn.filter((n) => /edit/i.test(n))).toEqual([]);
    expect(find<{ employee: { id: string } }>(tree, EmployeeDetail)?.employee.id).toBe('b');
  });

  it('★ where it answers is read for the SELECTED employee, named, and given to 07', async () => {
    loadReachability.mockResolvedValueOnce([
      { channel: 'WHATSAPP', reach: 'always' },
      { channel: 'WEBCHAT', reach: 'sometimes' },
    ]);
    const tree = await page([employee('a'), employee('b')], { employee: 'b' });
    expect(loadReachability).toHaveBeenLastCalledWith('b');
    // The web chat is the Website widget's row (the translator mock answers keys).
    const reach = [
      { channel: 'WHATSAPP', name: 'name.WHATSAPP', when: 'reach.always' },
      { channel: 'WEBCHAT', name: 'widgetRow.name', when: 'reach.sometimes' },
    ];
    expect(find<{ reach: unknown }>(tree, EmployeeDetail)?.reach).toEqual(reach);
  });

  it('★★ E1 - the platform, then the account’s own name, one line per account (Omer, 2026-10-13)', async () => {
    loadReachability.mockResolvedValueOnce([
      {
        channel: 'WHATSAPP',
        reach: 'always',
        accounts: [
          { channelAccountId: 'w1', displayName: 'שירות לקוחות', detail: '+972 50-123-4567' },
          { channelAccountId: 'w2', displayName: null, detail: '+972 52-000-0000' },
          { channelAccountId: 'w3', displayName: null, detail: null },
        ],
      },
      { channel: 'INSTAGRAM', reach: 'sometimes', accounts: [] },
    ]);
    const tree = await page([employee('a')], { employee: 'a' });
    expect(find<{ reach: unknown }>(tree, EmployeeDetail)?.reach).toEqual([
      {
        key: 'w1',
        channel: 'WHATSAPP',
        name: 'name.WHATSAPP · שירות לקוחות',
        when: 'reach.always',
      },
      // No display name: its phone, isolated so it reads left to right.
      {
        key: 'w2',
        channel: 'WHATSAPP',
        name: 'name.WHATSAPP · \u2066+972 52-000-0000\u2069',
        when: 'reach.always',
      },
      // An account with neither adds no line; a channel with no named account is the channel.
      { channel: 'INSTAGRAM', name: 'name.INSTAGRAM', when: 'reach.sometimes' },
    ]);
  });

  it('unread: null all the way down - the screens keep the line that says where it is decided', async () => {
    loadReachability.mockResolvedValueOnce(null);
    const tree = await page([employee('a')], {});
    expect(find<{ reach: unknown }>(tree, EmployeeDetail)?.reach).toBeNull();
  });

  it('?hired=<id> is that employee; an unknown id opens nothing', async () => {
    const tree = await page([employee('a'), employee('b')], { hired: 'b' });
    expect(find<{ employee: { id: string } }>(tree, HiredDialog)?.employee.id).toBe('b');
    expect(find(await page([employee('a')], { hired: 'zz' }), HiredDialog)).toBeNull();
  });
});

describe('★★ actions in words, by integration (Omer, 2026-10-07: "WooCommerce get customer")', () => {
  const setUp = async () => {
    const { capabilitySchema } = await import('@/api/contracts/capabilities');
    caps.value = [
      capabilitySchema.parse({
        toolName: 'woocommerce.get_customer',
        integration: 'woocommerce',
        kind: 'action',
      }),
    ];
    tools.value = [
      {
        name: 'woocommerce.get_customer',
        provider: 'woocommerce',
        providerLabel: 'WooCommerce',
        actionLabel: 'Get customer',
      },
    ];
  };

  it('★★ H2 - in the catalogue’s own words, as the platform answered them (Hebrew on a Hebrew page)', async () => {
    await setUp();
    caps.integrations = [
      integrationSchema.parse({
        id: 'i1',
        slug: 'woocommerce',
        name: 'WooCommerce',
        catalogTools: [
          { id: 'c1', toolName: 'get_customer', slug: 'get_customer', name: 'שליפת לקוח' },
        ],
      }),
    ];
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ tools: { label: string }[] }>(tree, HireSheet);
    expect(props?.tools.map((tool) => tool.label)).toEqual(['שליפת לקוח']);
    caps.integrations = [];
  });

  it('the hire flow: each action with its provider, to group by', async () => {
    await setUp();
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ tools: { label: string; provider: string | null }[] }>(tree, HireSheet);
    expect(props?.tools.map((tool) => [tool.label, tool.provider])).toEqual([
      ['Get customer', 'woocommerce'],
    ]);
  });

  it('★★ H8a: an integration action carries its grant - the seed’s rule; a built-in none', async () => {
    const { capabilitySchema } = await import('@/api/contracts/capabilities');
    const cap = (over: Record<string, unknown>) =>
      capabilitySchema.parse({ kind: 'action', integration: 'woocommerce', ...over });
    caps.value = [
      cap({ toolName: 'woocommerce.get_customer', state: 'enabled', riskLevel: 'LOW' }),
      cap({ toolName: 'woocommerce.refund', state: 'enabled', riskLevel: 'HIGH' }),
      cap({ toolName: 'woocommerce.new_coupon', state: 'not_provisioned', riskLevel: 'LOW' }),
      capabilitySchema.parse({ toolName: 'send_message', kind: 'system' }),
    ];
    tools.value = null;
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ tools: { toolName: string; grant: unknown }[] }>(tree, HireSheet);
    expect(Object.fromEntries(props!.tools.map((tool) => [tool.toolName, tool.grant]))).toEqual({
      'woocommerce.get_customer': { grantable: true, seeded: true },
      'woocommerce.refund': { grantable: true, seeded: false },
      'woocommerce.new_coupon': { grantable: false, seeded: false },
      send_message: null,
    });
    caps.value = [];
  });
});

describe('★★ E5 - the card names this employee’s own levels', () => {
  it('each action named: the server’s name with its integration, our words for GOTCHA’s own', async () => {
    caps.integrations = [{ slug: 'woocommerce', name: 'WooCommerce' }];
    employeeTools.value = [
      {
        toolName: 'woocommerce.get_customer',
        label: 'שליפת לקוח',
        integration: 'woocommerce',
        workspaceLevel: 'execute',
        ownLevel: 'ask',
        employeeLevel: 'ask',
        allowedLevels: ['execute', 'ask', 'never'],
      },
      {
        toolName: 'close_conversation',
        label: 'close_conversation',
        integration: null,
        workspaceLevel: 'execute',
        ownLevel: null,
        employeeLevel: 'execute',
        allowedLevels: ['execute', 'ask', 'never'],
      },
    ];
    const tree = await page([employee('a')], { employee: 'a' });
    const levels = find<{ levels: { label: string; employeeLevel: string }[] }>(
      tree,
      EmployeeDetail,
    )?.levels;
    expect(levels?.map((l) => [l.label, l.employeeLevel])).toEqual([
      ['WooCommerce · שליפת לקוח', 'ask'],
      ['tool.close_conversation', 'execute'],
    ]);
    employeeTools.value = null;
    caps.integrations = [];
  });
});
