import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/** The phone's conversation hands its composer the channel (prod 131053, 2026-11-15). */
const loadInbox = vi.hoisted(() => vi.fn());
vi.mock('@/features/inbox/load-inbox', () => ({ loadInbox }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => 'he',
}));
vi.mock('server-only', () => ({}));
const flag = vi.hoisted(() => ({ relevance: false }));
vi.mock('@/api/client/inbox-relevance', () => ({ inboxRelevanceOn: () => flag.relevance }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}), usePathname: () => '/' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({}),
}));

import { Composer } from '@/features/inbox/Composer';
import { CustomerWho } from '@/features/inbox/CustomerWho';
import { RelevanceControl } from '@/features/inbox/RelevanceControl';

const elements = (node: ReactNode, out: ReactElement[] = []): ReactElement[] => {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, ReactNode>)) {
      elements(value, out);
    }
  }
  return out;
};

const open = {
  id: 'c1',
  status: 'OPEN',
  channel: 'WHATSAPP',
  handledBy: 'human',
  assignedAgentId: 'me',
  assignedAiAgentId: null,
  isHandedOver: true,
  lastMessageAt: '2026-11-15T12:37:38Z',
  customerName: 'Omer',
  customerExternalId: '+972500000000',
  replyWindow: null,
  unread: false,
};

describe("★ the phone's composer knows the channel", () => {
  it('★★ WhatsApp, from the open conversation', async () => {
    loadInbox.mockResolvedValue({
      open,
      missing: null,
      meId: 'me',
      colleagues: [],
      greeting: null,
      detail: Promise.resolve({ messages: [], timeline: null, orders: null }),
    });
    const { default: Page } = await import('./page');
    const tree = await Page({ params: Promise.resolve({ id: 'c1' }) });
    const composer = elements(tree).find((e) => e.type === Composer);
    expect((composer?.props as { channel?: string | null }).channel).toBe('WHATSAPP');
  });
});

describe('★★ which number, on the phone thread (Omer, 2026-11-16)', () => {
  const tree = async (channelAccount: unknown) => {
    loadInbox.mockResolvedValue({
      open: { ...open, channelAccount },
      missing: null,
      meId: 'me',
      colleagues: [],
      greeting: null,
      detail: Promise.resolve({ messages: [], timeline: null, orders: null }),
    });
    const { default: Page } = await import('./page');
    return elements(await Page({ params: Promise.resolve({ id: 'c1' }) }));
  };

  it('★★ two numbers: the bar names the account, and the composer sends from it', async () => {
    const all = await tree({
      id: 'ch1',
      channel: 'WHATSAPP',
      displayName: 'Gotcha',
      multipleOfChannel: true,
    });
    const tag = all.find(
      (e) => (e.props as { 'data-testid'?: string })['data-testid'] === 'mobile-thread-account',
    );
    expect(tag?.type).toBe('bdi');
    expect((tag?.props as { children: unknown }).children).toBe('Gotcha');
    const composer = all.find((e) => e.type === Composer);
    expect((composer?.props as { accountName?: string | null }).accountName).toBe('Gotcha');
  });

  it('★ one number: no account in the bar, none in the composer', async () => {
    const all = await tree({
      id: 'ch9',
      channel: 'WHATSAPP',
      displayName: 'Only',
      multipleOfChannel: false,
    });
    expect(
      all.some(
        (e) => (e.props as { 'data-testid'?: string })['data-testid'] === 'mobile-thread-account',
      ),
    ).toBe(false);
    expect(
      (all.find((e) => e.type === Composer)?.props as { accountName?: string | null }).accountName,
    ).toBeNull();
  });
});

describe('★★ no name: the bar names the number (prod 2026-11-17)', () => {
  it('★★ the bar title is the shared chain, given the open conversation', async () => {
    loadInbox.mockResolvedValue({
      open: { ...open, customerName: null, customerExternalId: '972521234567' },
      missing: null,
      meId: 'me',
      colleagues: [],
      greeting: null,
      detail: Promise.resolve({ messages: [], timeline: null, orders: null }),
    });
    const { default: Page } = await import('./page');
    const all = elements(await Page({ params: Promise.resolve({ id: 'c1' }) }));
    const who = all.filter((e) => e.type === CustomerWho);
    expect(who).toHaveLength(1);
    render(who[0]!);
    expect(screen.getByTestId('customer-handle')).toHaveTextContent('052-123-4567');
    expect(screen.queryByText('queue.unnamed')).toBeNull();
  });
});

describe('★★ personal and not relevant, on the phone thread (INBOX_RELEVANCE)', () => {
  const thread = async (relevance: unknown) => {
    loadInbox.mockResolvedValue({
      open: { ...open, relevance },
      missing: null,
      meId: 'me',
      colleagues: [],
      greeting: null,
      detail: Promise.resolve({ messages: [], timeline: null, orders: null }),
    });
    const { default: Page } = await import('./page');
    const tree = await Page({ params: Promise.resolve({ id: 'c1' }) });
    return elements(tree).find((e) => e.type === RelevanceControl)?.props as
      { tag: string | null; override: string; classes?: Record<string, string> } | undefined;
  };

  it('★★ off: not drawn', async () => {
    flag.relevance = false;
    expect(await thread({ category: 'personal' })).toBeUndefined();
  });

  it('★★ on: the tag and "business" for a personal one, in the phone’s look', async () => {
    flag.relevance = true;
    const control = await thread({ category: 'personal' });
    expect(control).toMatchObject({ tag: 'personal', override: 'business' });
    expect(Object.keys(control?.classes ?? {}).sort()).toEqual([
      'button',
      'group',
      'note',
      'problem',
      'tag',
    ]);
  });

  it('★ on: a normal one offers "not relevant", with no tag', async () => {
    flag.relevance = true;
    expect(await thread(null)).toMatchObject({ tag: null, override: 'personal' });
  });
});
