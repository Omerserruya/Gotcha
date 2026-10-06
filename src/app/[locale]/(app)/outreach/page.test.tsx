import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const loadOutreach = vi.hoisted(() => vi.fn());
vi.mock('@/features/outreach/load-outreach', () => ({ loadOutreach }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, number>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('server-only', () => ({}));
const { loadChannels, loadTemplates } = vi.hoisted(() => ({
  loadChannels: vi.fn(async () => ({
    channels: [
      {
        id: 'wa1',
        channel: 'WHATSAPP',
        connectionStatus: 'CONNECTED',
        displayName: 'Support line',
      },
      { id: 'ig1', channel: 'INSTAGRAM', connectionStatus: 'CONNECTED', displayName: 'Shop' },
    ],
  })),
  loadTemplates: vi.fn(async () => ({
    templates: [
      { id: 't1', name: 'restock', language: 'he', status: 'APPROVED', channelAccountId: null },
      { id: 't2', name: 'draft_one', language: 'he', status: 'DRAFT', channelAccountId: null },
    ],
  })),
}));
vi.mock('@/features/channels/load-channels', () => ({ loadChannels }));
vi.mock('@/features/outreach/load-templates', () => ({ loadTemplates }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { CampaignCard } from '@/features/outreach/CampaignCard';
import { CampaignForm } from '@/features/outreach/CampaignForm';
import { TaskCards } from '@/features/outreach/TaskCards';
import { PageContainer } from '@/shell/PageContainer';

const propsOf = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === type) found = element.props as T;
    visit(element.props.children);
  };
  visit(tree);
  return found;
};

const c = (id: string, status: string) => ({ id, name: id, status, channel: 'WHATSAPP' });
const page = async (campaign?: string) => {
  loadOutreach.mockResolvedValue({
    inFlight: [c('s1', 'SENDING'), c('s2', 'SENDING'), c('sch', 'SCHEDULED')],
    finished: [c('done', 'COMPLETED')],
    unavailable: false,
  });
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(campaign ? { campaign } : {}) });
};

describe('★★ 05 - reaching out', () => {
  it('★ 02’s title, and a status sentence counted from the campaigns', async () => {
    const props = propsOf<{ title: string; description: string; flush?: boolean }>(
      await page(),
      PageContainer,
    );
    expect(props?.title).toBe('screenTitle');
    expect(props?.description).toBe('statusLine:{"running":2,"scheduled":1}');
    expect(props?.flush).toBe(true);
  });

  it('★★ the side column shows the campaign the URL names', async () => {
    expect(
      propsOf<{ campaign: { id: string } }>(await page('done'), CampaignCard)?.campaign.id,
    ).toBe('done');
  });

  it('⚠ and the first one when the URL names none - or one that is not there', async () => {
    expect(propsOf<{ campaign: { id: string } }>(await page(), CampaignCard)?.campaign.id).toBe(
      's1',
    );
    expect(
      propsOf<{ campaign: { id: string } }>(await page('gone'), CampaignCard)?.campaign.id,
    ).toBe('s1');
  });
});

describe('★★ 05 - creating outreach, as drafts (Omer, 2026-10-04)', () => {
  const at = async (query: Record<string, string>) => {
    loadOutreach.mockResolvedValue({
      inFlight: [c('a', 'SENDING')],
      finished: [],
      unavailable: false,
    });
    const { default: Page } = await import('./page');
    return Page({ searchParams: Promise.resolve(query) });
  };

  it('"Create outreach" in the header, and the task cards over the list', async () => {
    const tree = await at({});
    const header = propsOf<{ actions: { props: { href: unknown } } }>(tree, PageContainer);
    expect(header?.actions.props.href).toEqual({
      pathname: '/outreach',
      query: { create: 'campaign' },
    });
    // No email account connected: the Email card is drawn, not linked.
    expect(propsOf<{ hasEmail: boolean }>(tree, TaskCards)?.hasEmail).toBe(false);
    expect(propsOf(tree, CampaignForm)).toBeNull();
    expect(loadTemplates).not.toHaveBeenCalled();
  });

  it('?create=campaign: the drawer, with sendable accounts and APPROVED templates only', async () => {
    const tree = await at({ create: 'campaign', template: 't1' });
    const form = propsOf<{
      accounts: { id: string }[];
      templates: { id: string }[];
      initialTemplateId?: string;
    }>(tree, CampaignForm);
    expect(form?.accounts.map((a) => a.id)).toEqual(['wa1']);
    expect(form?.templates.map((tpl) => tpl.id)).toEqual(['t1']);
    expect(form?.initialTemplateId).toBe('t1');
  });
});
