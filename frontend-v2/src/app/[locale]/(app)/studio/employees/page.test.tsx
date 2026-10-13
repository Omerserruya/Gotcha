import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import { EmployeeDetail } from '@/features/employees/EmployeeDetail';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import { EditSheet } from '@/features/employees/edit/EditSheet';
import { HireSheet } from '@/features/employees/hire/HireSheet';
import { HiredDialog } from '@/features/employees/hired/HiredDialog';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';

const loadEmployees = vi.hoisted(() => vi.fn());
const loadIntegrationAccess = vi.hoisted(() => vi.fn(async () => null));
const loadReachability = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ channel: string; reach: string; accounts?: unknown[] }[] | null> => null,
  ),
);
vi.mock('@/features/employees/load-employees', () => ({
  loadEmployees,
  loadIntegrationAccess,
  loadReachability,
}));
const caps = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadCapabilities: async () => ({ capabilities: caps.value, usage: null, integrations: [] }),
}));
const tools = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/features/skills/skill-actions', () => ({ readTools: async () => tools.value }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('server-only', () => ({}));
const { loadChannels, loadKnowledge } = vi.hoisted(() => ({
  loadChannels: vi.fn(async () => ({
    channels: [
      { channel: 'WHATSAPP', connectionStatus: 'CONNECTED' },
      { channel: 'EMAIL', connectionStatus: 'ERROR' },
    ],
  })),
  loadKnowledge: vi.fn(async () => ({ sources: [{ name: 'Returns policy' }] })),
}));
vi.mock('@/features/channels/load-channels', () => ({ loadChannels }));
vi.mock('@/features/knowledge/load-knowledge', () => ({ loadKnowledge }));
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
    loadKnowledge.mockClear();
    const tree = await page([employee('a')]);
    expect(find(tree, HireSheet)).toBeNull();
    expect(loadChannels).not.toHaveBeenCalled();
    expect(loadKnowledge).not.toHaveBeenCalled();
  });

  it("?hire=1&step=2: the sheet at step 2, and no channels - where it works is not the hire flow's", async () => {
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ initialStep: number; knowledge: string[] }>(tree, HireSheet);
    expect(props?.initialStep).toBe(2);
    expect(props).not.toHaveProperty('channels');
    expect(props?.knowledge).toEqual(['Returns policy']);
  });
});

describe('★ 07e / 07f - the dialog and the sheet, by query', () => {
  it('neither without its query', async () => {
    const tree = await page([employee('a')]);
    expect(find(tree, EditSheet)).toBeNull();
    expect(find(tree, HiredDialog)).toBeNull();
  });

  it('?edit=1 edits the SELECTED employee', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'b', edit: '1' });
    expect(find<{ employee: { id: string } }>(tree, EditSheet)?.employee.id).toBe('b');
    // Its business systems are read for THAT employee, and only when editing.
    expect(loadIntegrationAccess).toHaveBeenLastCalledWith('b');
  });

  it('★ where it answers is read for the SELECTED employee, named, and given to 07 and 07f', async () => {
    loadReachability.mockResolvedValueOnce([
      { channel: 'WHATSAPP', reach: 'always' },
      { channel: 'WEBCHAT', reach: 'sometimes' },
    ]);
    const tree = await page([employee('a'), employee('b')], { employee: 'b', edit: '1' });
    expect(loadReachability).toHaveBeenLastCalledWith('b');
    // The web chat is the Website widget's row (the translator mock answers keys).
    const reach = [
      { channel: 'WHATSAPP', name: 'name.WHATSAPP', when: 'reach.always' },
      { channel: 'WEBCHAT', name: 'widgetRow.name', when: 'reach.sometimes' },
    ];
    expect(find<{ reach: unknown }>(tree, EmployeeDetail)?.reach).toEqual(reach);
    expect(find<{ reach: unknown }>(tree, EditSheet)?.reach).toEqual(reach);
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

  it('07f: "WooCommerce · Get customer" - the catalogue\'s words, never the tool\'s name', async () => {
    await setUp();
    const tree = await page([employee('a')], { employee: 'a', edit: '1' });
    const sheet = find<{ mayDo: { label: string }[] }>(tree, EditSheet);
    expect(sheet?.mayDo.map((m) => m.label)).toEqual(['WooCommerce · Get customer']);
  });

  it('the hire flow: each action with its provider, to group by', async () => {
    await setUp();
    const tree = await page([employee('a')], { hire: '1', step: '2' });
    const props = find<{ tools: { label: string; provider: string | null }[] }>(tree, HireSheet);
    expect(props?.tools.map((tool) => [tool.label, tool.provider])).toEqual([
      ['Get customer', 'woocommerce'],
    ]);
  });
});
