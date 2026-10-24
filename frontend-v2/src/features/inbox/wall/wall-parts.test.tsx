import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderCard } from '@/api/contracts/customer-orders';
import plateStyles from '@/design-system/brand/channel-plate.module.css';
import channels from '@/i18n/messages/en/channels.json';
import customers from '@/i18n/messages/en/customers.json';
import inbox from '@/i18n/messages/en/inbox.json';

import { FILL_COMPOSER_EVENT, type ComposerFill } from '../reply-event';
import { AskCopilot } from './AskCopilot';
import type { WallConversation, WallHistory } from './load-wall';
import { OrdersCarousel } from './OrdersCarousel';
import { WallBody } from './WallBody';

const messages = vi.hoisted(() => vi.fn());
vi.mock('./wall-actions', () => ({ conversationMessages: messages }));
const chat = vi.hoisted(() => ({
  readCopilotChat: vi.fn(),
  askCopilotChat: vi.fn(),
  clearCopilotChat: vi.fn(),
}));
vi.mock('./copilot-chat-actions', () => chat);
const runOrder = vi.hoisted(() => vi.fn());
vi.mock('@/features/customers/order-actions', () => ({ runOrderAction: runOrder }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Jerusalem"
      messages={{ inbox, channels, customers }}
    >
      {node}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  messages.mockReset();
  for (const fn of Object.values(chat)) fn.mockReset();
  chat.readCopilotChat.mockResolvedValue({ ok: true, turns: [] });
  runOrder.mockReset();
});

const conv = (id: string, over: Partial<WallConversation> = {}): WallConversation => ({
  id,
  channel: 'WHATSAPP',
  status: 'OPEN',
  startedAt: '2026-09-01T10:00:00Z',
  lastAt: '2026-09-02T10:00:00Z',
  messages: 4,
  summary: `Summary of ${id}`,
  isCurrent: false,
  ...over,
});

const history: WallHistory = {
  total: 24,
  hasMore: true,
  conversations: [
    conv('c1', { isCurrent: true }),
    conv('c2', { channel: 'INSTAGRAM', summary: null }),
    conv('c3', { channel: 'VOICE' }),
  ],
};

describe('★★ History across all channels - three levels over the column', () => {
  const show = (h: WallHistory | null = history) =>
    wrap(
      <WallBody history={h} why="The conversation names no customer yet.">
        <p data-testid="wall-child">the wall</p>
      </WallBody>,
    );

  it('the row: total, written channels by name, calls by count', () => {
    show();
    expect(screen.getByTestId('wall-history-line')).toHaveTextContent(
      '24 conversations · WhatsApp, Instagram, 1 call',
    );
  });

  it('★ unread: the shape, "-", and why - never "0 conversations"', () => {
    show(null);
    const row = screen.getByTestId('wall-history');
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('title', 'The conversation names no customer yet.');
    expect(screen.getByTestId('wall-history-line')).toHaveTextContent('-');
  });

  it('★★ 1 → 2 → 3 and back: the list covers the wall; the summary needs no read', async () => {
    messages.mockResolvedValue({
      ok: true,
      messages: [
        {
          id: 'm1',
          direction: 'INBOUND',
          body: 'Where is my order?',
          createdAt: '2026-09-02T09:00:00Z',
          messageType: 'text',
        },
      ],
    });
    show();
    fireEvent.click(screen.getByTestId('wall-history'));
    expect(screen.queryByTestId('wall-child')).toBeNull();
    expect(screen.getByTestId('wall-drill')).toHaveAttribute('data-level', 'list');
    expect(screen.getByTestId('wall-history-c1')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('wall-history-more')).toHaveTextContent(
      'Showing the newest 3 of 24.',
    );
    // "No summary yet" - not an empty line.
    expect(screen.getByTestId('wall-summary-c2')).toHaveTextContent('No summary yet');
    // ★★ Each conversation wears its channel's own mark - the shared component.
    const glyph = (id: string) =>
      screen.getByTestId(`wall-channel-${id}`).querySelector('[data-channel-mark]');
    expect(glyph('c1')).toHaveAttribute('data-glyph', 'whatsapp');
    expect(glyph('c2')).toHaveAttribute('data-glyph', 'instagram');
    expect(glyph('c3')).toHaveAttribute('data-glyph', 'phone');
    // ★★ On the shared plate - the light ground the dark wall needs.
    const plate = glyph('c1')?.closest('[data-channel-plate]');
    expect(plate).toHaveAttribute('data-channel-plate', 'md');
    expect(plate?.classList).toContain(plateStyles.plate);
    // Decorative: the channel's name is the first words beside it.
    expect(glyph('c1')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByTestId('wall-history-c1'));
    expect(screen.getByTestId('wall-drill')).toHaveAttribute('data-level', 'summary');
    expect(screen.getByTestId('wall-summary-c1')).toHaveTextContent('Summary of c1');
    expect(messages).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('wall-open-whole'));
    expect(await screen.findByTestId('wall-whole')).toHaveTextContent('Where is my order?');
    expect(messages).toHaveBeenCalledWith('c1');

    fireEvent.click(screen.getByTestId('wall-back'));
    expect(screen.getByTestId('wall-drill')).toHaveAttribute('data-level', 'summary');
    fireEvent.click(screen.getByTestId('wall-open-whole'));
    // Read once per visit.
    expect(messages).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('wall-back'));
    fireEvent.click(screen.getByTestId('wall-back'));
    fireEvent.click(screen.getByTestId('wall-back'));
    expect(screen.getByTestId('wall-child')).toBeInTheDocument();
  });

  it('a failed read of the whole conversation says so', async () => {
    messages.mockResolvedValue({ ok: false });
    show();
    fireEvent.click(screen.getByTestId('wall-history'));
    fireEvent.click(screen.getByTestId('wall-history-c2'));
    fireEvent.click(screen.getByTestId('wall-open-whole'));
    expect(await screen.findByTestId('wall-whole-failed')).toBeInTheDocument();
  });
});

const order = (id: string, over: Partial<OrderCard> = {}): OrderCard =>
  ({
    orderId: id,
    orderNumber: `#18${id}`,
    adminUrl: 'https://shop.myshopify.com/admin/orders/1',
    createdAt: '2026-08-14T10:00:00Z',
    total: { amount: 179, currency: 'ILS' },
    financial: { key: 'paid', label: 'Paid', tone: 'positive' },
    fulfillment: null,
    cancelled: false,
    refund: null,
    shipping: { key: 'in_transit', label: 'In transit', tone: 'neutral' },
    items: [{ title: 'Linen set', quantity: 1, imageUrl: null }],
    extraItemCount: 0,
    timeline: [],
    detail: null,
    refundedAmount: { amount: null, currency: null },
    refundableMaximum: { amount: null, currency: null },
    eligibility: {
      cancellable: false,
      refundable: true,
      returnable: false,
      exchangeable: false,
      reasonIfNot: 'Already fulfilled.',
    },
    ...over,
  }) as OrderCard;

describe('★★ Order #1842 · 2 of 6', () => {
  const show = (orders: OrderCard[], start = 0) =>
    wrap(
      <OrdersCarousel
        source="shopify"
        state="ok"
        missing={[]}
        orders={orders}
        start={start}
        conversationId="c1"
      />,
    );

  it('opens where it is told, and steps', () => {
    show([order('41'), order('42'), order('43')], 1);
    expect(screen.getByTestId('wall-order-number')).toHaveTextContent('Order #1842');
    expect(screen.getByTestId('wall-orders-position')).toHaveTextContent('2 of 3');
    fireEvent.click(screen.getByTestId('wall-orders-next'));
    expect(screen.getByTestId('wall-order-number')).toHaveTextContent('Order #1843');
    expect(screen.getByTestId('wall-orders-next')).toBeDisabled();
  });

  it('★★ Refund and Replace always drawn; what this order cannot do is disabled, with why', () => {
    show([order('41')]);
    const refund = screen.getByTestId('order-action-41-refund');
    const replace = screen.getByTestId('order-action-41-exchange_item');
    expect(refund).toHaveTextContent('Refund');
    expect(refund).toBeEnabled();
    expect(replace).toHaveTextContent('Replace');
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute('title', 'Already fulfilled.');
    // Nothing is pressed by a render.
    expect(runOrder).not.toHaveBeenCalled();
  });

  it('★ Track only with a link; Open in Shopify only to a Shopify admin host', () => {
    show([
      order('41', {
        adminUrl: 'https://evil.example/admin',
        detail: { lineItems: [], tracking: [], shippingAddress: null, refunds: [] },
      }),
    ]);
    expect(screen.getByTestId('wall-order-track')).toBeDisabled();
    expect(screen.queryByTestId('wall-order-admin')).toBeNull();
  });

  it('a link when there is one', () => {
    show([
      order('41', {
        detail: {
          lineItems: [],
          tracking: [{ number: '1', url: 'https://track.example/1', company: null }],
          shippingAddress: null,
          refunds: [],
        },
      }),
    ]);
    expect(screen.getByTestId('wall-order-track')).toHaveAttribute(
      'href',
      'https://track.example/1',
    );
    expect(screen.getByTestId('wall-order-admin')).toHaveAttribute(
      'href',
      'https://shop.myshopify.com/admin/orders/1',
    );
  });

  it.each([
    [null, 'unread'],
    ['not_connected', 'not_connected'],
    ['ok', 'ok'],
  ] as const)('★ no order to show (%s) says which nothing it is', (state, attr) => {
    wrap(
      <OrdersCarousel
        source="shopify"
        state={state}
        missing={[]}
        orders={[]}
        start={0}
        conversationId="c1"
      />,
    );
    expect(screen.getByTestId('wall-orders')).toHaveAttribute('data-state', attr);
    expect(screen.getByTestId('wall-orders-note').textContent?.trim()).not.toBe('');
  });
});

describe('★★ WooCommerce, by contact (e30900fd) - read-only, and says how it matched', () => {
  const woo = (over: Partial<OrderCard> = {}) => ({
    ...order('91', {
      adminUrl: 'https://shop.example/wp-admin/post.php?post=91&action=edit',
      eligibility: {
        cancellable: false,
        refundable: false,
        returnable: false,
        exchangeable: false,
        reasonIfNot: 'actions_not_supported_for_store',
      },
      ...over,
    }),
    matchedBy: 'phone' as const,
  });
  const showWoo = (orders: ReturnType<typeof woo>[], reason: string | null = null) =>
    wrap(
      <OrdersCarousel
        source={reason ? null : 'woocommerce'}
        state={null}
        reason={reason}
        missing={[]}
        orders={orders}
        start={0}
        conversationId="c1"
      />,
    );

  it('★★ Refund and Replace drawn, disabled, with the sentence - not the platform’s code', () => {
    showWoo([woo()]);
    for (const id of ['order-action-91-refund', 'order-action-91-exchange_item']) {
      expect(screen.getByTestId(id)).toBeDisabled();
      expect(screen.getByTestId(id)).toHaveAttribute(
        'title',
        'Refunds from here work with Shopify only for now.',
      );
    }
  });

  it('★ "Matched by phone"; and "Open in WooCommerce" to its admin', () => {
    showWoo([woo()]);
    expect(screen.getByTestId('wall-order-matched')).toHaveTextContent('Matched by phone');
    const admin = screen.getByTestId('wall-order-admin');
    expect(admin).toHaveTextContent('Open in WooCommerce');
    expect(admin).toHaveAttribute(
      'href',
      'https://shop.example/wp-admin/post.php?post=91&action=edit',
    );
  });

  it('⚠ a Woo admin link that is not the edit page is no link', () => {
    showWoo([woo({ adminUrl: 'https://evil.example/login' })]);
    expect(screen.queryByTestId('wall-order-admin')).toBeNull();
  });

  it('verified needs no word', () => {
    wrap(
      <OrdersCarousel
        source="shopify"
        state="ok"
        missing={[]}
        orders={[{ ...order('41'), matchedBy: 'verified' as const }]}
        start={0}
        conversationId="c1"
      />,
    );
    expect(screen.queryByTestId('wall-order-matched')).toBeNull();
  });

  it('★ no orders in Woo: says which store', () => {
    showWoo([]);
    expect(screen.getByTestId('wall-orders-note')).toHaveTextContent(
      'No orders from this customer in WooCommerce.',
    );
  });

  it('★★ two stores, none chosen: says so, and links to choose', () => {
    showWoo([], 'store_not_chosen');
    expect(screen.getByTestId('wall-orders-note')).toHaveTextContent('Two stores are connected');
    expect(screen.getByTestId('wall-orders-choose')).toHaveAttribute('href', '/settings/systems');
  });

  it.each([
    ['no_store_connected', 'No store is connected'],
    ['store_unreachable', 'couldn’t be reached'],
    ['no_identifiers', 'no email or phone'],
  ])('%s → its own sentence', (reason, words) => {
    showWoo([], reason);
    expect(screen.getByTestId('wall-orders-note')).toHaveTextContent(words);
  });
});

const turn = (
  id: string,
  role: 'agent' | 'copilot',
  text: string,
  draft: string | null = null,
) => ({
  id,
  role,
  text,
  draft,
  at: '2026-10-24T22:00:00Z',
});

describe('★★ the Copilot side chat - a private thread, never to the customer', () => {
  it("★★ the thread the server keeps is drawn on open, the agent's and the Copilot's", async () => {
    chat.readCopilotChat.mockResolvedValue({
      ok: true,
      turns: [
        turn('1', 'agent', 'Where is the order?'),
        turn('2', 'copilot', 'It shipped Monday.'),
      ],
    });
    wrap(<AskCopilot conversationId="c1" />);
    expect(await screen.findByTestId('wall-chat-copilot')).toHaveTextContent('It shipped Monday.');
    expect(screen.getByTestId('wall-chat-agent')).toHaveTextContent('Where is the order?');
    expect(chat.readCopilotChat).toHaveBeenCalledWith('c1');
    expect(screen.getByTestId('wall-chat')).toHaveTextContent(
      'Nothing in it reaches the customer.',
    );
  });

  it('★★ asking: the question shows at once, then the thread the server answers with; the composer is untouched', async () => {
    let answer: (value: unknown) => void = () => {};
    chat.askCopilotChat.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const fills: ComposerFill[] = [];
    const onFill = (e: Event) => fills.push((e as CustomEvent<ComposerFill>).detail);
    window.addEventListener(FILL_COMPOSER_EVENT, onFill);
    wrap(<AskCopilot conversationId="c1" />);
    const input = screen.getByTestId('wall-ask-input');
    fireEvent.change(input, { target: { value: 'Can we refund?' } });
    fireEvent.click(screen.getByTestId('wall-ask-send'));
    expect(await screen.findByTestId('wall-chat-asking')).toHaveTextContent('Can we refund?');
    expect(screen.getByTestId('wall-chat-thinking')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(chat.askCopilotChat).toHaveBeenCalledWith('c1', 'Can we refund?', 'en');
    answer({
      ok: true,
      turns: [turn('1', 'agent', 'Can we refund?'), turn('2', 'copilot', 'Yes, within 14 days.')],
    });
    expect(await screen.findByTestId('wall-chat-copilot')).toHaveTextContent(
      'Yes, within 14 days.',
    );
    expect(screen.queryByTestId('wall-chat-thinking')).toBeNull();
    // No draft: nothing to put in the reply box, and nothing put there.
    expect(screen.queryByTestId('wall-chat-use')).toBeNull();
    window.removeEventListener(FILL_COMPOSER_EVENT, onFill);
    expect(fills).toEqual([]);
  });

  it('★★ a draft reaches the composer only through "Use as reply", selected; never by itself', async () => {
    chat.readCopilotChat.mockResolvedValue({
      ok: true,
      turns: [turn('2', 'copilot', 'Offer a refund.', 'Hi Dana, we have refunded your order.')],
    });
    const fills: ComposerFill[] = [];
    const onFill = (e: Event) => fills.push((e as CustomEvent<ComposerFill>).detail);
    window.addEventListener(FILL_COMPOSER_EVENT, onFill);
    wrap(<AskCopilot conversationId="c1" />);
    expect(await screen.findByTestId('wall-chat-draft')).toHaveTextContent(
      'Hi Dana, we have refunded your order.',
    );
    expect(fills).toEqual([]);
    fireEvent.click(screen.getByTestId('wall-chat-use'));
    window.removeEventListener(FILL_COMPOSER_EVENT, onFill);
    expect(fills).toEqual([{ text: 'Hi Dana, we have refunded your order.', select: true }]);
  });

  it.each([
    ['busy', 'still on its way'],
    ['no_ai_employee', 'no AI employee yet'],
    ['too_long', 'Up to 4,000 characters'],
  ] as const)('%s: says so, and keeps the message in the field', async (reason, words) => {
    chat.askCopilotChat.mockResolvedValue({ ok: false, reason });
    wrap(<AskCopilot conversationId="c1" />);
    fireEvent.change(screen.getByTestId('wall-ask-input'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByTestId('wall-ask-send'));
    const note = await screen.findByTestId('wall-ask-note');
    expect(note).toHaveAttribute('data-reason', reason);
    expect(note).toHaveTextContent(words);
    expect(screen.getByTestId('wall-ask-input')).toHaveValue('Hi');
    expect(screen.queryByTestId('wall-ask-retry')).toBeNull();
  });

  it('★ a failed round stored nothing: it says so, and "Try again" sends the same words', async () => {
    chat.askCopilotChat.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    chat.askCopilotChat.mockResolvedValueOnce({
      ok: true,
      turns: [turn('1', 'agent', 'Hi'), turn('2', 'copilot', 'Hello.')],
    });
    wrap(<AskCopilot conversationId="c1" />);
    fireEvent.change(screen.getByTestId('wall-ask-input'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByTestId('wall-ask-send'));
    fireEvent.click(await screen.findByTestId('wall-ask-retry'));
    expect(await screen.findByTestId('wall-chat-copilot')).toHaveTextContent('Hello.');
    expect(chat.askCopilotChat).toHaveBeenNthCalledWith(2, 'c1', 'Hi', 'en');
  });

  it('★ start over empties the thread on the server, then here', async () => {
    chat.readCopilotChat.mockResolvedValue({ ok: true, turns: [turn('2', 'copilot', 'Old.')] });
    chat.clearCopilotChat.mockResolvedValue({ ok: true, turns: [] });
    wrap(<AskCopilot conversationId="c1" />);
    fireEvent.click(await screen.findByTestId('wall-chat-start-over'));
    await waitFor(() => expect(screen.queryByTestId('wall-chat')).toBeNull());
    expect(chat.clearCopilotChat).toHaveBeenCalledWith('c1');
  });

  it('★ not on the plan: said once, and the field is off', async () => {
    chat.readCopilotChat.mockResolvedValue({ ok: false, reason: 'not_on_plan' });
    wrap(<AskCopilot conversationId="c1" />);
    expect(await screen.findByTestId('wall-ask-note')).toHaveAttribute(
      'data-reason',
      'not_on_plan',
    );
    expect(screen.getByTestId('wall-ask-input')).toBeDisabled();
  });

  it('nothing open: off, says why, and reads nothing', () => {
    wrap(<AskCopilot conversationId={null} />);
    expect(screen.getByTestId('wall-ask-input')).toBeDisabled();
    expect(screen.getByTestId('wall-ask-send')).toBeDisabled();
    expect(chat.readCopilotChat).not.toHaveBeenCalled();
  });
});
