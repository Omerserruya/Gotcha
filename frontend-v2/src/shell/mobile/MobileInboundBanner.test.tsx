import { act, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import common from '@/i18n/messages/en/common.json';
import inbox from '@/i18n/messages/en/inbox.json';
import type { RealtimeEvent } from '@/realtime/events';

import { MobileInboundBanner } from './MobileInboundBanner';

/* Nothing here reaches a route: the read, the router and the socket are doubles. */
const handler = vi.hoisted(() => ({ current: null as ((e: RealtimeEvent) => void) | null }));
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (_type: string, fn: (e: RealtimeEvent) => void) => {
    handler.current = fn;
  },
}));
const row = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { get: row } }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/m/inbox',
}));

const message = (conversationId: string, messageId: string): RealtimeEvent => ({
  type: 'message.received',
  tenantId: 't1',
  at: 0,
  conversationId,
  messageId,
  direction: 'INBOUND',
  body: 'Is the coat back in stock?',
  messageType: 'text',
});

function show() {
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox, common }}>
      <MobileInboundBanner meId="me" />
    </NextIntlClientProvider>,
  );
}

describe('MobileInboundBanner', () => {
  beforeEach(() => {
    row.mockReset();
    push.mockReset();
  });

  it("★ a customer writes in a conversation that is nobody's: a banner, tap opens it", async () => {
    row.mockResolvedValue({
      customerName: 'Dana',
      customerExternalId: null,
      assignedAgentId: null,
    });
    show();
    act(() => handler.current!(message('c1', 'm1')));
    const banner = await screen.findByTestId('mobile-inbound-banner');
    expect(banner).toHaveTextContent('Dana');
    expect(banner).toHaveTextContent('Is the coat back in stock?');
    act(() => screen.getByTestId('mobile-inbound-banner-open').click());
    expect(push).toHaveBeenCalledWith('/m/inbox/c1');
  });

  it("★ a colleague's conversation: no banner", async () => {
    row.mockResolvedValue({
      customerName: 'Dana',
      customerExternalId: null,
      assignedAgentId: 'someone',
    });
    show();
    act(() => handler.current!(message('c2', 'm2')));
    await waitFor(() => expect(row).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('mobile-inbound-banner')).toBeNull();
  });
});
