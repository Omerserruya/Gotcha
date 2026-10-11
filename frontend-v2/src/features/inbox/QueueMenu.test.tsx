import { readFileSync } from 'node:fs';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import inbox from '@/i18n/messages/en/inbox.json';
import navigation from '@/i18n/messages/en/navigation.json';

/*
 * ⚠⚠ EVERY ACTION HERE CHANGES A REAL CONVERSATION, and two of them greet a
 *    real customer. All five are mocked; none is reachable from this file.
 */
const actions = vi.hoisted(() => ({
  claimConversation: vi.fn(),
  transferConversation: vi.fn(),
  releaseConversation: vi.fn(),
  closeConversation: vi.fn(),
  deleteConversation: vi.fn(),
  returnToAi: vi.fn(),
  stopAi: vi.fn(),
}));
vi.mock('./conversation-actions', () => actions);

/** The locale-aware router: where a verb on one row sends the list. */
const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query: Record<string, string> };
    children: React.ReactNode;
  }) => (
    <a {...rest} href={`${href.pathname}?${new URLSearchParams(href.query).toString()}`}>
      {children}
    </a>
  ),
}));

import { QueueMenu } from './QueueMenu';
import { clearSelected, toggleSelected } from './queue-selection';

const rows = [
  { id: 'c1', status: 'OPEN', assignedAgentId: null },
  { id: 'c2', status: 'CLOSED', assignedAgentId: 'me' },
  { id: 'c3', status: 'WAITING', assignedAgentId: 'u2' },
];

const show = (over: { role?: string | null; greeting?: boolean | null } = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox, navigation }}>
      <QueueMenu
        rows={rows}
        meId="me"
        role={over.role === undefined ? 'ADMIN' : over.role}
        colleagues={[{ id: 'u2', name: 'Noa' }]}
        greeting={over.greeting === undefined ? true : over.greeting}
      >
        <ol>
          {rows.map((row) => (
            <li key={row.id}>
              <a href="#" data-conversation-id={row.id} data-testid={`row-${row.id}`}>
                {row.id}
              </a>
            </li>
          ))}
          <li data-testid="not-a-row">note</li>
        </ol>
      </QueueMenu>
    </NextIntlClientProvider>,
  );

const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue({ ok: true });
  push.mockReset();
});
afterEach(() => act(() => clearSelected()));

describe('★★ right-click a row: the menu acts on that row', () => {
  it('★★ offers what applies to it - an open, unassigned conversation, seen by an admin', () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    expect(screen.getByTestId('menu-assign-me')).toBeInTheDocument();
    expect(screen.getByTestId('menu-assign-someone')).toBeInTheDocument();
    expect(screen.queryByTestId('menu-release')).toBeNull(); // nobody holds it
    expect(screen.getByTestId('menu-resolve')).toBeInTheDocument();
    expect(screen.getByTestId('menu-delete')).toBeInTheDocument();
  });

  it('⚠ never the three without a live backend', () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    const menu = screen.getByTestId('queue-menu');
    expect(menu.textContent).not.toMatch(/pause|unread|archive/i);
  });

  it('⚠⚠ Assign to me says it greets the customer - before it is pressed', () => {
    show({ greeting: true });
    rightClick(screen.getByTestId('row-c1'));
    expect(screen.getByTestId('menu-assign-me')).toHaveTextContent(/greeting/i);
  });

  it('★ pressing an item runs it on that row', async () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-resolve'));
    await waitFor(() => expect(actions.closeConversation).toHaveBeenCalledWith('c1'));
  });

  it('⚠ an agent is not offered Delete - the route would refuse them', () => {
    show({ role: 'AGENT' });
    rightClick(screen.getByTestId('row-c1'));
    expect(screen.queryByTestId('menu-delete')).toBeNull();
  });

  it('★ right-clicking outside any row opens no menu at all', () => {
    show();
    rightClick(screen.getByTestId('not-a-row'));
    expect(screen.queryByTestId('queue-menu')).toBeNull();
  });
});

describe('⚠⚠ Delete asks first, and forces only what is still open', () => {
  it('★★ nothing is deleted until the confirmation is pressed', async () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-delete'));
    expect(screen.getByTestId('queue-delete-confirm')).toHaveTextContent(/can’t be undone/);
    expect(actions.deleteConversation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('queue-delete-cancel'));
    expect(actions.deleteConversation).not.toHaveBeenCalled();
  });

  it('★★ an OPEN conversation is deleted with force - Omer’s ruling', async () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-delete'));
    expect(screen.getByTestId('queue-delete-confirm')).toHaveTextContent(/still open/);
    await userEvent.click(screen.getByTestId('queue-delete-confirm-button'));
    await waitFor(() => expect(actions.deleteConversation).toHaveBeenCalledWith('c1', true));
  });

  it('★ a CLOSED one without', async () => {
    show();
    rightClick(screen.getByTestId('row-c2'));
    await userEvent.click(screen.getByTestId('menu-delete'));
    await userEvent.click(screen.getByTestId('queue-delete-confirm-button'));
    await waitFor(() => expect(actions.deleteConversation).toHaveBeenCalledWith('c2', false));
  });
});

describe('★★ shift-click picks several, and the menu acts on all of them', () => {
  it('★★ Mark resolved runs on each picked conversation it applies to', async () => {
    act(() => {
      toggleSelected('c1');
      toggleSelected('c3');
    });
    show();
    expect(screen.getByTestId('queue-selection')).toHaveTextContent('2 selected');
    rightClick(screen.getByTestId('row-c3'));
    await userEvent.click(screen.getByTestId('menu-resolve'));
    await waitFor(() => expect(actions.closeConversation).toHaveBeenCalledTimes(2));
    expect(actions.closeConversation.mock.calls.map((c) => c[0])).toEqual(['c1', 'c3']);
  });

  it('⚠ right-clicking a row OUTSIDE the selection lets the selection go', async () => {
    act(() => toggleSelected('c1'));
    show();
    rightClick(screen.getByTestId('row-c3'));
    expect(screen.queryByTestId('queue-selection')).toBeNull();
    await userEvent.click(screen.getByTestId('menu-resolve'));
    await waitFor(() => expect(actions.closeConversation).toHaveBeenCalledWith('c3'));
    expect(actions.closeConversation).toHaveBeenCalledTimes(1);
  });

  it('★ when only some go through, it says how many', async () => {
    actions.closeConversation
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'failed' });
    act(() => {
      toggleSelected('c1');
      toggleSelected('c3');
    });
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-resolve'));
    expect(await screen.findByTestId('queue-menu-notice')).toHaveTextContent('Done for 1 of 2');
  });
});

describe('★ 02’s item is 30 tall, and items stack at 1px', () => {
  it('the dark menu’s lines are `normal` - inherited 1.6 made each item 36', () => {
    const css = readFileSync(
      'src/design-system/primitives/overlay/overlay.module.css',
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const dark = /\.surface\[data-appearance='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark).toMatch(/line-height:\s*normal/);
    expect(dark).toMatch(/gap:\s*1px/);
  });
});

describe('★★ Stop AI and Back to the AI, from the menu', () => {
  const aiRows = [
    {
      id: 'a1',
      status: 'OPEN',
      assignedAgentId: null,
      assignedAiAgentId: 'bot',
      isHandedOver: false,
    },
    {
      id: 'a2',
      status: 'OPEN',
      assignedAgentId: 'me',
      assignedAiAgentId: 'bot',
      isHandedOver: true,
    },
  ];
  const showAi = () =>
    render(
      <NextIntlClientProvider locale="en" messages={{ inbox, navigation }}>
        <QueueMenu rows={aiRows} meId="me" role="AGENT" colleagues={[]} greeting={true}>
          <ol>
            {aiRows.map((row) => (
              <li key={row.id}>
                <a href="#" data-conversation-id={row.id} data-testid={`row-${row.id}`}>
                  {row.id}
                </a>
              </li>
            ))}
          </ol>
        </QueueMenu>
      </NextIntlClientProvider>,
    );

  it('the AI’s conversation: Stop AI stops it (stop-ai) - not claim, which assigns and greets', async () => {
    showAi();
    rightClick(screen.getByTestId('row-a1'));
    expect(screen.queryByTestId('menu-assign-me')).toBeNull();
    await userEvent.click(await screen.findByTestId('menu-stop-ai'));
    expect(actions.stopAi).toHaveBeenCalledWith('a1');
    expect(actions.claimConversation).not.toHaveBeenCalled();
  });

  it('one already taken: Back to the AI hands it back (return-to-ai)', async () => {
    showAi();
    rightClick(screen.getByTestId('row-a2'));
    await userEvent.click(await screen.findByTestId('menu-back-to-ai'));
    expect(actions.returnToAi).toHaveBeenCalledWith('a2');
    // and the list follows it into "Handled by GOTCHA", still open
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        { pathname: '/inbox', query: { view: 'gotcha', c: 'a2' } },
        { scroll: false },
      ),
    );
  });
});

describe('★★ the list follows the conversation, as the header’s buttons do (2026-10-11)', () => {
  it('★★ Assign to me on one row: to "Assigned to me", that conversation open', async () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-assign-me'));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith(
      { pathname: '/inbox', query: { view: 'mine', c: 'c1' } },
      { scroll: false },
    );
    expect(screen.queryByTestId('queue-menu-notice')).toBeNull();
  });

  it('★★ several picked: the list stays, and says where they went with a link', async () => {
    act(() => {
      toggleSelected('c1');
      toggleSelected('c3');
    });
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-assign-me'));
    const notice = await screen.findByTestId('queue-menu-notice');
    expect(notice).toHaveTextContent(/^2 conversations moved to Assigned to me\.$/);
    expect(screen.getByTestId('queue-menu-moved-link')).toHaveAttribute('href', '/inbox?view=mine');
    expect(push).not.toHaveBeenCalled();
  });

  it('⚠⚠ a refused one stays where it is and says why', async () => {
    actions.claimConversation.mockResolvedValueOnce({ ok: false, reason: 'already_claimed' });
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-assign-me'));
    expect(await screen.findByTestId('queue-menu-notice')).toHaveTextContent(
      inbox.verbs.problem.already_claimed,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('⚠ an action that moves nothing between views (Resolve) does not move the list', async () => {
    show();
    rightClick(screen.getByTestId('row-c1'));
    await userEvent.click(screen.getByTestId('menu-resolve'));
    await waitFor(() => expect(actions.closeConversation).toHaveBeenCalledWith('c1'));
    expect(push).not.toHaveBeenCalled();
  });
});
