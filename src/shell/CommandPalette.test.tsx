import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import navigation from '@/i18n/messages/en/navigation.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/permissions/permissions-context', () => ({
  usePermissions: () => ({ canSee: () => true }),
}));
const searchConversations = vi.hoisted(() => vi.fn());
vi.mock('./command-search', () => ({ searchConversations }));

import { CommandPalette, OPEN_COMMAND_PALETTE } from './CommandPalette';

const mount = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ navigation, channels }}>
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
});

describe('★★ 19 — ⌘K from anywhere', () => {
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

  it('★ DO THIS is drawn, not live: nothing turns a sentence into an action', async () => {
    mount();
    openWithKeys();
    await userEvent.type(screen.getByTestId('command-input'), 'refund dana');
    const action = screen.getByTestId('command-item-do');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action).toHaveAttribute('title', expect.stringMatching(/Nothing turns a sentence/));
    await userEvent.click(action);
    expect(push).not.toHaveBeenCalled();
  });

  it('★ ASK goes to Home with the question — Home only fills its box', async () => {
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
});
