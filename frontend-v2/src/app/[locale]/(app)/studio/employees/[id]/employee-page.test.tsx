import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import { WhoAnswers } from '@/features/employees/WhoAnswers';
import { EmployeeHead, EmployeeTabs } from '@/features/employees/page/EmployeeFrame';
import { EmployeeKnowledge } from '@/features/employees/page/EmployeeKnowledge';
import { EmployeeProfile } from '@/features/employees/page/EmployeeProfile';
import { EmployeeSkills } from '@/features/skills/EmployeeSkills';
import capabilities from '@/i18n/messages/en/capabilities.json';
import channels from '@/i18n/messages/en/channels.json';
import employees from '@/i18n/messages/en/employees.json';
import skills from '@/i18n/messages/en/skills.json';

const messages = { employees, skills, channels, capabilities };
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn() }),
}));
// No write may leave a test: every action the tabs could call fails loudly.
vi.mock('@/features/employees/actions', () => ({
  saveEmployeeEdits: () => {
    throw new Error('write');
  },
}));

const reads = vi.hoisted(() => ({
  page: vi.fn(),
  access: vi.fn(),
  reach: vi.fn(),
  knowledge: vi.fn(),
  skillsTab: vi.fn(),
}));
vi.mock('@/features/employees/page/load-employee-page', () => ({ loadEmployeePage: reads.page }));
vi.mock('@/features/employees/load-employees', () => ({
  loadIntegrationAccess: reads.access,
  loadReachability: reads.reach,
}));
vi.mock('@/features/employees/page/load-employee-knowledge', () => ({
  loadEmployeeKnowledge: reads.knowledge,
}));
vi.mock('@/features/skills/load-skills', () => ({ loadEmployeeSkillsTab: reads.skillsTab }));
vi.mock('@/features/capabilities/load-capabilities', () => ({
  loadCapabilities: async () => ({
    capabilities: [
      { toolName: 'woocommerce.get_customer', kind: 'action', integration: 'woocommerce' },
    ].map((c) => ({ ...c, availability: 'on', approval: 'never' })),
    integrations: [],
  }),
}));
vi.mock('@/features/skills/skill-actions', () => ({
  readTools: async () => [
    {
      name: 'woocommerce.get_customer',
      provider: 'woocommerce',
      providerLabel: 'WooCommerce',
      actionLabel: 'Get customer',
    },
  ],
}));

const maya = employeeSchema.parse({
  id: 'a',
  name: 'Maya',
  departmentId: 'd1',
  identity: { responsibility: 'After-sale questions' },
  knowledgeSources: [{ id: 'k1', name: 'Returns', isActive: true }],
});

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

const params = Promise.resolve({ id: 'a' });
const tabOf = (tree: ReactNode) =>
  find<{ id: string; current: string; skillsCount: number | null }>(tree, EmployeeTabs);

beforeEach(() => {
  reads.page.mockResolvedValue({ employee: maya, missing: false, skillsCount: 2 });
  reads.access.mockResolvedValue({ allowed: [], choices: [] });
  reads.reach.mockResolvedValue([{ channel: 'WHATSAPP', reach: 'always' }]);
  reads.knowledge.mockResolvedValue([]);
  reads.skillsTab.mockResolvedValue({
    assigned: { aiAgentId: 'a', noSkillPolicy: 'answer_from_knowledge', skills: [] },
    candidates: [],
    situations: new Map(),
  });
});

describe('★★ the employee page: four tabs, each its own page with real content, none a sheet', () => {
  it('Profile (/studio/employees/a): the employee, its systems, and what it may do in words', async () => {
    const { default: Page } = await import('./page');
    const tree = await Page({ params });
    const props = find<{
      employee: { id: string };
      access: unknown;
      mayDo: { label: string; stance: string }[];
    }>(tree, EmployeeProfile);
    expect(props?.employee.id).toBe('a');
    expect(reads.access).toHaveBeenCalledWith('a');
    expect(props?.access).toEqual({ allowed: [], choices: [] });
    expect(props?.mayDo.map((m) => m.label)).toEqual(['WooCommerce · Get customer']);
    expect(tabOf(tree)).toEqual({ id: 'a', current: 'profile', skillsCount: 2 });
    expect(find<{ employee: { id: string } }>(tree, EmployeeHead)?.employee.id).toBe('a');
  });

  it('Knowledge: what is connected, and the workspace’s list', async () => {
    const sources = [{ id: 'k1', name: 'Returns' }];
    reads.knowledge.mockResolvedValue(sources);
    const { default: Page } = await import('./knowledge/page');
    const tree = await Page({ params });
    const props = find<{ connected: unknown; sources: unknown; employee: unknown }>(
      tree,
      EmployeeKnowledge,
    );
    expect(props?.connected).toEqual([{ id: 'k1', name: 'Returns', isActive: true }]);
    expect(props?.sources).toBe(sources);
    expect(props?.employee).toEqual({ id: 'a', name: 'Maya', departmentId: 'd1' });
    expect(tabOf(tree)?.current).toBe('knowledge');
  });

  it('Skills: its list, and its own count on the tab', async () => {
    const { default: Page } = await import('./skills/page');
    const tree = await Page({ params });
    expect(find<{ employee: { id: string } }>(tree, EmployeeSkills)?.employee.id).toBe('a');
    expect(tabOf(tree)).toEqual({ id: 'a', current: 'skills', skillsCount: 0 });
    // The tab's own list is the count: the frame does not read it again.
    expect(reads.page).toHaveBeenLastCalledWith('a', { withSkills: false });
  });

  it('Channels: where it answers, by the playbook, named', async () => {
    const { default: Page } = await import('./channels/page');
    const tree = await Page({ params });
    expect(reads.reach).toHaveBeenCalledWith('a');
    expect(find<{ reach: unknown }>(tree, WhoAnswers)?.reach).toEqual([
      { channel: 'WHATSAPP', name: 'WhatsApp', when: 'Always' },
    ]);
    expect(tabOf(tree)?.current).toBe('channels');
  });

  it('an employee not in the roster, or an unread one: says which, and draws no tab', async () => {
    for (const [read, words] of [
      [{ employee: null, missing: true, skillsCount: null }, "This employee isn't here."],
      [{ employee: null, missing: false, skillsCount: null }, "This employee couldn't be read"],
    ] as const) {
      reads.page.mockResolvedValue(read);
      for (const path of ['./page', './knowledge/page', './channels/page'] as const) {
        const { default: Page } = await import(path);
        const tree = await Page({ params });
        expect(tabOf(tree)).toBeNull();
        const { unmount } = render(<>{tree}</>);
        expect(screen.getByTestId('employee-page-unread')).toHaveTextContent(words);
        unmount();
      }
    }
  });
});

describe('★★ the tabs: Profile, Knowledge, Skills, Channels - no Limits tab', () => {
  it('in order, each to its page; the current one is not a link', async () => {
    render(await EmployeeTabs({ id: 'a', current: 'knowledge', skillsCount: 3 }));
    const nav = screen.getByTestId('employee-tabs');
    const tabs = within(nav).getAllByText(/./);
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Profile',
      'Knowledge',
      'Skills · 3',
      'Channels',
    ]);
    expect(screen.getByTestId('employee-tab-profile')).toHaveAttribute(
      'href',
      '/studio/employees/a',
    );
    expect(screen.getByTestId('employee-tab-skills')).toHaveAttribute(
      'href',
      '/studio/employees/a/skills',
    );
    expect(screen.getByTestId('employee-tab-channels')).toHaveAttribute(
      'href',
      '/studio/employees/a/channels',
    );
    expect(screen.getByTestId('employee-tab-knowledge')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('employee-tab-knowledge')).not.toHaveAttribute('href');
    expect(nav).not.toHaveTextContent(/Limits|handover/i);
    // No tab leads to a sheet, or off the employee's page.
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^\/studio\/employees\/a(\/(skills|channels))?$/);
    }
  });

  it('the skills count unread: the tab without a number', async () => {
    render(await EmployeeTabs({ id: 'a', current: 'profile', skillsCount: null }));
    expect(screen.getByTestId('employee-tab-skills')).toHaveTextContent(/^Skills$/);
  });

  it('the head: the name and what it is responsible for', async () => {
    render(await EmployeeHead({ employee: maya }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Maya');
    expect(document.body).toHaveTextContent('After-sale questions');
  });
});
