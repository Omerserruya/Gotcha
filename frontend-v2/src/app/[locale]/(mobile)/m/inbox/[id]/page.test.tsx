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
vi.mock('@/i18n/navigation', () => ({ Link: 'a', useRouter: () => ({}), usePathname: () => '/' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({}),
}));

import { Composer } from '@/features/inbox/Composer';

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
