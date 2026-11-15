import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/** The phone's Home for one person (Omer, 2026-11-15): Open, as on the website. */
const loadHomeData = vi.hoisted(() => vi.fn());
vi.mock('@/features/home/load-home-data', () => ({
  loadHomeData,
  loadViewerFirstName: async () => null,
}));
vi.mock('next-intl/server', () => ({
  // The key, with its values, so a test can see which sentence and which number.
  getTranslations: async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ''}`,
  getFormatter: async () => ({ dateTime: () => 'date', number: (n: number) => String(n) }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { MobileHome } from './MobileHome';

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

const item = {
  conversationId: 'c1',
  customer: { id: '+972541234567', name: 'Dana' },
  channel: 'WHATSAPP',
  preview: 'Hi',
  intent: null,
  waitingSince: '2026-11-15T09:00:00Z',
};

const home = async (over: Record<string, unknown>) => {
  loadHomeData.mockResolvedValue({
    overview: {
      aiHandledCount: 2,
      totalConversations: 4,
      humanHandledCount: 1,
      pendingApprovalCount: 0,
    },
    queue: { waiting: 0 },
    queueItems: { data: [], totalWaiting: 0 },
    activity: [],
    isQuiet: false,
    setup: null,
    gate: null,
    open: null,
    ...over,
  });
  return JSON.stringify(elements(await MobileHome({ account: null })).map((e) => e.props));
};

describe("★★ one person: the phone's Home says Open", () => {
  it('★★ the headline counts Open, and the card lists it with "more open" to "Open"', async () => {
    const tree = await home({ open: { count: 5, items: [item] } });
    expect(tree).toContain('mobile.home.handledOpen{\\"handled\\":2,\\"open\\":5}');
    expect(tree).not.toContain('handledWaiting');
    expect(tree).toContain('Dana');
    expect(tree).toContain('mobile.home.moreOpen{\\"count\\":4}');
    expect(tree).toContain('{"pathname":"/m/inbox","query":{"view":"open"}}');
  });

  it('⚠ none open, and unread, each say so', async () => {
    expect(await home({ open: { count: 0, items: [] } })).toContain('home.needsYou.open.empty');
    expect(await home({ open: { count: null, items: null } })).toContain(
      'home.needsYou.open.unavailable',
    );
  });

  it("★ a team is today's: the queue's count and words", async () => {
    const tree = await home({ queue: { waiting: 3 } });
    expect(tree).toContain('mobile.home.handledWaiting{\\"handled\\":2,\\"waiting\\":3}');
    expect(tree).not.toContain('handledOpen');
  });
});

describe("★★ the phone's lock-out notice is drawn as in-app (App Store 3.1.1)", () => {
  it('★ a gated workspace: TenantGateNotice, told it may be inside the app', async () => {
    const { TenantGateNotice } = await import('@/features/tenant-gate/TenantGateNotice');
    loadHomeData.mockResolvedValue({
      overview: null,
      queue: null,
      queueItems: null,
      activity: null,
      isQuiet: false,
      setup: null,
      gate: { code: 'TENANT_PAYMENT_REQUIRED', checkoutPath: '/checkout' },
      open: null,
    });
    const notice = elements(await MobileHome({ account: null })).find(
      (e) => e.type === TenantGateNotice,
    );
    expect((notice?.props as { inApp?: boolean }).inApp).toBe(true);
  });
});
