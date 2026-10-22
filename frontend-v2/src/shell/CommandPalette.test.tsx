import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import navigation from '@/i18n/messages/en/navigation.json';
import common from '@/i18n/messages/en/common.json';
import inbox from '@/i18n/messages/en/inbox.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/permissions/permissions-context', () => ({
  usePermissions: () => ({ canSee: () => true }),
}));
const searchConversations = vi.hoisted(() => vi.fn());
const searchPeople = vi.hoisted(() => vi.fn());
vi.mock('./command-search', () => ({ searchConversations, searchPeople }));

import { CommandPalette, OPEN_COMMAND_PALETTE } from './CommandPalette';

const mount = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ navigation, channels, common, inbox }}>
      <CommandPalette />
    </NextIntlClientProvider>,
  );

const openWithKeys = () => fireEvent.keyDown(window, { key: 'k', metaKey: true });

beforeEach(() => {
  push.mockReset();
  searchConversations.mockReset();
  searchConversations.mockResolvedValue({
    ok: true,
    hits: [{ id: 'c1', name: 'Dana Cohen', handle: '+97250', channel: 'WHATSAPP' }],
  });
  searchPeople.mockReset();
  searchPeople.mockResolvedValue({ ok: true, people: [], actions: [] });
});

describe('★★ 19 - ⌘K from anywhere', () => {
  it('closed until ⌘K, Ctrl K, or the rail’s button; Esc closes', async () => {
    mount();
    expect(screen.queryByTestId('command-palette')).toBeNull();
    openWithKeys();
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByTestId('command-input')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('command-palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('command-palette')).toBeNull();
    act(() => void window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE)));
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('★★ on a Hebrew keyboard: Ctrl and the K key types "ל", and still opens it (Omer, 2026-10-11)', () => {
    mount();
    fireEvent.keyDown(window, { key: 'ל', code: 'KeyK', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('⚠ Ctrl and another key on a Hebrew keyboard opens nothing', () => {
    mount();
    fireEvent.keyDown(window, { key: 'ך', code: 'KeyL', ctrlKey: true });
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('empty: GO TO the screens, nothing else', () => {
    mount();
    openWithKeys();
    expect(screen.getByTestId('command-group-go')).toHaveTextContent('Home');
    expect(screen.queryByTestId('command-group-do')).toBeNull();
    expect(screen.queryByTestId('command-group-ask')).toBeNull();
  });

  it('typed: a screen by its words, a conversation by the customer, and ASK', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'knowledge');
    expect(screen.getByTestId('command-item-screen-studio.knowledge')).toHaveTextContent(
      'Studio · Knowledge',
    );
    expect(await screen.findByTestId('command-item-conversation-c1')).toHaveTextContent(
      'Dana Cohen',
    );
    expect(screen.getByTestId('command-item-conversation-c1')).toHaveTextContent(
      'WhatsApp · conversation',
    );
    expect(searchConversations).toHaveBeenLastCalledWith('knowledge');
    expect(screen.getByTestId('command-item-ask')).toHaveTextContent('Ask GOTCHA: “knowledge”');
  });

  it('★ DO THIS only for what can be acted on - nothing pending, no section at all', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'refund dana');
    await screen.findByTestId('command-item-conversation-c1');
    expect(screen.queryByTestId('command-group-do')).toBeNull();
  });

  it('★★ a pending approval for a customer found: DO THIS, with 02’s chip, opening Approvals', async () => {
    searchPeople.mockResolvedValue({
      ok: true,
      people: [{ id: 'k1', name: 'Dana Cohen', handle: '+97250', byOrder: null }],
      actions: [{ id: 'a1', summary: 'Refund Dana Cohen · order #1842' }],
    });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'dana');
    const action = await screen.findByTestId('command-item-approval-a1');
    expect(action).toHaveTextContent('Refund Dana Cohen · order #1842');
    expect(action).toHaveTextContent('Needs approval');
    await userEvent.click(action);
    expect(push).toHaveBeenCalledWith('/approvals');
  });

  it('★ a Shopify visitor stored as "Shopper on <shop>" is found as a website shopper - never the stored string', async () => {
    searchConversations.mockResolvedValue({
      ok: true,
      hits: [
        {
          id: 'c9',
          name: 'Shopper on urban-supply-gotcha-demo.myshopify.com',
          handle: null,
          channel: 'SHOPIFY_LIVE_CHAT',
        },
      ],
    });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'shop');
    const hit = await screen.findByTestId('command-item-conversation-c9');
    expect(hit).toHaveTextContent('Website shopper');
    expect(hit).not.toHaveTextContent('myshopify');
  });

  it('★ GO TO a customer - by name, or by an order number', async () => {
    searchPeople.mockResolvedValue({
      ok: true,
      people: [
        { id: 'k1', name: 'Dana Cohen', handle: '+97250', byOrder: null },
        { id: 'k2', name: 'Noa Gil', handle: null, byOrder: '#1842' },
      ],
      actions: [],
    });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'dana');
    expect(await screen.findByTestId('command-item-customer-k1')).toHaveTextContent(
      'Dana Cohencustomer · +97250',
    );
    expect(screen.getByTestId('command-item-customer-k2')).toHaveTextContent('Order #1842Noa Gil');
    await userEvent.click(screen.getByTestId('command-item-customer-k1'));
    expect(push).toHaveBeenCalledWith('/customers/k1');
  });

  it('★ ASK goes to Home with the question - Home only fills its box', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'how many refunds?');
    await userEvent.click(screen.getByTestId('command-item-ask'));
    expect(push).toHaveBeenCalledWith('/home?ask=how%20many%20refunds%3F');
    expect(screen.queryByTestId('command-palette')).toBeNull();
  });

  it('↑↓ and ↵ run the active item; Enter on nothing does nothing', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'channels');
    await screen.findByTestId('command-item-conversation-c1');
    // First live item is the conversation; one down is the first screen.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(push).toHaveBeenCalledWith('/settings/channels');
  });

  it('a failed search says so, and the screens still work', async () => {
    searchConversations.mockResolvedValue({ ok: false });
    searchPeople.mockResolvedValue({ ok: false });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'dana');
    expect(await screen.findByTestId('command-search-failed')).toBeInTheDocument();
  });

  it('closing forgets the question', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'dana');
    await userEvent.keyboard('{Escape}');
    openWithKeys();
    expect(screen.getByTestId('command-input')).toHaveValue('');
  });

  it('★ one person’s conversations told apart: their last word and when, on the right', async () => {
    searchConversations.mockResolvedValue({
      ok: true,
      hits: [
        {
          id: 'c1',
          name: 'Matan Amran',
          handle: null,
          channel: 'WHATSAPP',
          lastAt: '2026-10-03T09:00:00Z',
          lastWord: 'Cancel order #1016',
        },
        {
          id: 'c2',
          name: 'Matan Amran',
          handle: null,
          channel: 'WHATSAPP',
          lastAt: null,
          lastWord: 'היי',
        },
        {
          id: 'c3',
          name: 'Matan Amran',
          handle: null,
          channel: 'WHATSAPP',
          lastAt: '2026-10-02T09:00:00Z',
          lastWord: null,
          lastKind: 'photo',
        },
      ],
    });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'matan');
    expect(await screen.findByTestId('command-item-conversation-c1')).toHaveTextContent(
      'Cancel order #1016 · 3 Oct',
    );
    expect(
      screen.getByTestId('command-item-conversation-c2').querySelector('bdi'),
    ).toHaveTextContent('היי');
    // A photo is "Photo", in the reader's words - never its stored "[Image]".
    expect(screen.getByTestId('command-item-conversation-c3')).toHaveTextContent('Photo · 2 Oct');
  });

  it('★ an order number that found nobody: a quiet line - the search ran', async () => {
    searchPeople.mockResolvedValue({
      ok: true,
      people: [],
      actions: [],
      orderMiss: { kind: 'no_match', number: '1016', source: 'woocommerce' },
    });
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), '1016');
    expect(await screen.findByTestId('command-order-miss')).toHaveTextContent(
      'No customer here matches order #1016 in WooCommerce.',
    );
  });
});
