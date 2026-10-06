import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import customers from '@/i18n/messages/en/customers.json';
import inbox from '@/i18n/messages/en/inbox.json';

import type { ConversationDetail } from '../load-inbox';
import type { WallPerson } from './load-wall';

const messages = { inbox, channels, customers };

/* The real catalogue behind the server translator: a wrong key fails here, not on dev. */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const person = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<WallPerson>>());
vi.mock('./load-wall', () => ({ loadWallPerson: person }));
vi.mock('./SuggestionCarousel', () => ({ SuggestionCarousel: () => null }));
vi.mock('./wall-actions', () => ({ conversationMessages: vi.fn(), readActivity: vi.fn() }));
vi.mock('../conversation-actions', () => ({ stopAi: vi.fn() }));
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: () => undefined,
  useConversationRoom: () => undefined,
}));
vi.mock('@/features/customers/order-actions', () => ({ runOrderAction: vi.fn() }));

import { CopilotWall, WallHeader } from './CopilotWall';

/** Runs the async server components in a tree, as the RSC renderer would. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return resolve(await (element.type as (p: unknown) => Promise<ReactNode>)(element.props));
  }
  if (element.props.children === undefined) return element;
  return cloneElement(element, undefined, await resolve(element.props.children));
}

const show = async (tree: Promise<ReactNode> | ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Jerusalem" messages={messages}>
      {await resolve(await tree)}
    </NextIntlClientProvider>,
  );

const blank: WallPerson = { commerce: null, mood: null, memory: null, history: null, orders: null };

const detail = (over: Partial<ConversationDetail> = {}): Promise<ConversationDetail> =>
  Promise.resolve({ messages: [], timeline: null, orders: null, ...over } as ConversationDetail);

const wall = (
  contactId: string | null = null,
  over: Partial<ConversationDetail> = {},
  channel: string | null = 'WHATSAPP',
) =>
  CopilotWall({
    detail: detail(over),
    conversation: { id: 'c1', contactId, customerName: 'Dana Cohen', channel },
  });

beforeEach(() => {
  person.mockReset().mockResolvedValue(blank);
});

describe('★ the header outside a provider', () => {
  it('Copilot, and "-": nothing running, so no stop', async () => {
    await show(WallHeader({ conversationId: 'c1', aiDriving: true }));
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByTestId('wall-working')).toHaveAttribute('data-working', 'no');
    expect(screen.queryByTestId('wall-stop')).toBeNull();
  });
});

describe('★★ an unidentified visitor (c240bea4) - one line, not three blocks of "-"', () => {
  it('Shopify live chat with no contact: the line; no person, orders, history or reads', async () => {
    await show(wall(null, {}, 'SHOPIFY_LIVE_CHAT'));
    expect(screen.getByTestId('wall-visitor')).toHaveTextContent(
      'An unidentified visitor - history, memory and orders appear once they’re identified.',
    );
    expect(screen.queryByTestId('wall-person')).toBeNull();
    expect(screen.queryByTestId('wall-orders')).toBeNull();
    expect(screen.queryByTestId('wall-history')).toBeNull();
    expect(person).not.toHaveBeenCalled();
    // What the AI does still shows: a visitor is still a conversation.
    expect(screen.getByTestId('wall-activity')).toBeInTheDocument();
  });

  it('★ a visitor once identified is a person', async () => {
    await show(wall('k1', {}, 'SHOPIFY_LIVE_CHAT'));
    expect(screen.queryByTestId('wall-visitor')).toBeNull();
    expect(screen.getByTestId('wall-person')).toBeInTheDocument();
  });

  it('⚠ any other channel without a contact is "-", not "a visitor"', async () => {
    await show(wall(null));
    expect(screen.queryByTestId('wall-visitor')).toBeNull();
  });
});

describe('★★ the person, from what exists today', () => {
  it('★★ no contact yet: every contact-keyed value is "-" with why, never a zero', async () => {
    await show(wall());
    expect(person).toHaveBeenCalledWith(null, 'c1');
    expect(screen.getByText('Dana Cohen')).toBeInTheDocument();
    for (const stat of ['lifetime', 'orders', 'mood']) {
      const value = screen.getByTestId(`wall-stat-${stat}`);
      expect(value).toHaveTextContent('-');
      expect(value).toHaveAttribute('title', expect.stringContaining('does not name its customer'));
    }
    expect(screen.queryByTestId('wall-profile')).toBeNull();
  });

  it('★ the store’s summary through the conversation: Lifetime, Orders, Since', async () => {
    await show(
      wall(null, {
        orders: {
          state: 'ok',
          missing: [],
          summary: null,
          data: {
            summary: {
              orderCount: 6,
              shopCurrencyTotal: { amount: 2140, currency: 'ILS' },
              customerSince: '2024-03-10T00:00:00Z',
              totalSpentByCurrency: [],
            },
            recentOrders: [],
            fetchedAt: null,
            customer: null,
          },
        } as never,
      }),
    );
    expect(screen.getByTestId('wall-stat-lifetime')).toHaveTextContent('₪2,140');
    expect(screen.getByTestId('wall-stat-orders')).toHaveTextContent('6');
    expect(screen.getByTestId('wall-person-since')).toHaveTextContent('Since March 2024');
    // Six orders, none read: refunds cannot be counted.
    expect(screen.getByTestId('wall-stat-refunds')).toHaveTextContent('-');
  });

  it('with a contact: Profile, and Mood in its words', async () => {
    person.mockResolvedValue({ ...blank, mood: 'frustrated' });
    await show(wall('k1'));
    expect(screen.getByTestId('wall-profile')).toHaveAttribute('href', '/customers/k1');
    expect(screen.getByTestId('wall-stat-mood')).toHaveTextContent('Upset');
    expect(screen.getByTestId('wall-stat-mood')).toHaveAttribute('data-tone', 'frustrated');
  });
});

describe('★★ What GOTCHA learned - what the AI is given', () => {
  it('facts with a readable label and a quiet source; "From before" apart', async () => {
    person.mockResolvedValue({
      ...blank,
      memory: {
        facts: [{ key: 'business_type', value: 'Boutique', source: 'conversation' }],
        historical: { summary: 'Buys linen.', facts: ['Prefers M'] },
      },
    });
    await show(wall());
    const fact = screen.getByTestId('wall-fact-business_type');
    expect(fact).toHaveTextContent('Business type');
    expect(fact).toHaveTextContent('Boutique · from a conversation');
    const before = screen.getByTestId('wall-memory-before');
    expect(before).toHaveTextContent('From before');
    expect(before).toHaveTextContent('Prefers M');
  });

  it('★ empty: says so, and how it learns', async () => {
    person.mockResolvedValue({ ...blank, memory: { facts: [], historical: null } });
    await show(wall());
    expect(screen.getByTestId('wall-memory-none')).toHaveTextContent(
      'GOTCHA hasn’t learned anything about this customer yet.',
    );
  });

  it('★ unread is not empty', async () => {
    await show(wall());
    expect(screen.getByTestId('wall-memory-unread')).toHaveTextContent('-');
    expect(screen.queryByTestId('wall-memory-none')).toBeNull();
  });
});
