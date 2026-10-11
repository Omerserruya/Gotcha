import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { automationSchema, type Automation } from '@/api/contracts/automations';
import automationsMessages from '@/i18n/messages/en/automations.json';
import commonMessages from '@/i18n/messages/en/common.json';

/**
 * ★★ 09c with the keyboard and the right button (Omer, 2026-10-07): click,
 * ⌘/Ctrl-click and Shift-click select; ⌘/Ctrl+A all; Esc clears; Delete
 * asks, naming the count; right-click acts on the row or the selection -
 * and nothing fires while typing.
 */
const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
const actions = vi.hoisted(() => ({ setLive: vi.fn(), deleteAutomation: vi.fn() }));
vi.mock('./automation-actions', () => actions);

const { AutomationsList } = await import('./AutomationsList');

const automation = (id: string, status: string, over: Record<string, unknown> = {}): Automation =>
  automationSchema.parse({
    id,
    name: `Automation ${id}`,
    description: null,
    trigger: { type: 'message_received', config: {} },
    status,
    path: [{ nodeId: 't', type: 'automation_trigger', label: 'Message received' }],
    stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
    updatedAt: '2026-10-06T09:00:00Z',
    ...over,
  });

const LIST = [automation('a1', 'live'), automation('a2', 'paused'), automation('a3', 'draft')];

const show = () =>
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Jerusalem"
      now={new Date('2026-10-06T10:00:00Z')}
      messages={{ automations: automationsMessages, common: commonMessages }}
    >
      <AutomationsList automations={LIST} />
    </NextIntlClientProvider>,
  );

const row = (id: string) => screen.getByTestId(`automation-${id}`);
const cell = (id: string) => within(row(id)).getByTestId(`automation-path-${id}`);
const selected = () =>
  LIST.map((a) => a.id).filter((id) => row(id).getAttribute('aria-selected') === 'true');
const key = (k: string, mod = false) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, metaKey: mod });
  });

beforeEach(() => {
  push.mockReset();
  actions.setLive.mockReset();
  actions.deleteAutomation.mockReset();
});

describe('★★ selecting rows', () => {
  it('click selects one; ⌘/Ctrl-click adds; Shift-click a range', () => {
    show();
    fireEvent.click(cell('a1'));
    expect(selected()).toEqual(['a1']);
    fireEvent.click(cell('a3'), { ctrlKey: true });
    expect(selected()).toEqual(['a1', 'a3']);
    fireEvent.click(cell('a1'));
    fireEvent.click(cell('a3'), { shiftKey: true });
    expect(selected()).toEqual(['a1', 'a2', 'a3']);
    expect(screen.getByTestId('automations-select-hint')).toHaveTextContent('3 selected');
  });

  it('a plain click on the name still opens it; a ⌘-click on it picks instead', () => {
    show();
    const name = screen.getByTestId('automation-open-a2');
    const plain = fireEvent.click(name);
    expect(plain).toBe(true); // not prevented: the link navigates
    const modified = fireEvent.click(name, { metaKey: true });
    expect(modified).toBe(false); // prevented: no new tab
    expect(selected()).toEqual(['a2']);
  });

  it('⌘/Ctrl+A selects all; Esc clears', () => {
    show();
    key('a', true);
    expect(selected()).toEqual(['a1', 'a2', 'a3']);
    key('Escape');
    expect(selected()).toEqual([]);
  });

  it('★ on a Hebrew keyboard the A key types "ש" - Ctrl+A still selects all', () => {
    show();
    fireEvent.keyDown(window, { key: 'ש', code: 'KeyA', ctrlKey: true });
    expect(selected()).toEqual(['a1', 'a2', 'a3']);
  });

  it('★ nothing fires while typing in a field', () => {
    show();
    fireEvent.click(cell('a1'));
    const field = document.createElement('input');
    document.body.appendChild(field);
    act(() => {
      fireEvent.keyDown(field, { key: 'a', metaKey: true });
      fireEvent.keyDown(field, { key: 'Backspace' });
    });
    expect(selected()).toEqual(['a1']);
    expect(screen.queryByTestId('delete-automation')).toBeNull();
    field.remove();
  });
});

describe('★★ Delete asks, naming the count', () => {
  it('Delete on three: "Delete 3 automations?", and each one goes', async () => {
    actions.deleteAutomation.mockResolvedValue(true);
    show();
    key('a', true);
    key('Delete');
    expect(screen.getByTestId('delete-automation')).toHaveTextContent('Delete 3 automations?');
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(actions.deleteAutomation.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2', 'a3']);
    expect(screen.queryByTestId('automation-a1')).toBeNull();
    expect(screen.queryByTestId('delete-automation')).toBeNull();
  });

  it('one that is not deleted stays, is said, and a retry asks only for it', async () => {
    actions.deleteAutomation.mockImplementation(async (id: string) => id !== 'a2');
    show();
    key('a', true);
    key('Backspace');
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(screen.queryByTestId('automation-a1')).toBeNull();
    expect(screen.getByTestId('automation-a2')).toBeInTheDocument();
    expect(screen.getByTestId('delete-automation-failed')).toBeInTheDocument();
    expect(screen.getByTestId('delete-automation')).toHaveTextContent('Delete “Automation a2”?');
  });
});

describe('★★ right-click', () => {
  const rightClick = (id: string) => fireEvent.contextMenu(cell(id), { clientX: 10, clientY: 10 });

  it('on one row: Open, Pause (it is live), Delete - and it becomes the selection', () => {
    show();
    rightClick('a1');
    expect(selected()).toEqual(['a1']);
    const menu = screen.getByTestId('automations-menu');
    expect(within(menu).getByTestId('menu-open')).toBeInTheDocument();
    expect(within(menu).getByTestId('menu-pause')).toBeInTheDocument();
    expect(within(menu).queryByTestId('menu-turn-on')).toBeNull();
    expect(within(menu).getByTestId('menu-delete')).toHaveTextContent('Delete');
    fireEvent.click(within(menu).getByTestId('menu-open'));
    expect(push).toHaveBeenCalledWith('/studio/automations/a1');
  });

  it('on a selection: Turn on and Pause for all, each its own call; no Open', async () => {
    actions.setLive.mockImplementation(async (id: string, on: boolean) => ({
      ok: true,
      automation: automation(id, on ? 'live' : 'paused'),
      warnings: [],
    }));
    show();
    key('a', true);
    rightClick('a2');
    expect(selected()).toEqual(['a1', 'a2', 'a3']);
    const menu = screen.getByTestId('automations-menu');
    expect(within(menu).queryByTestId('menu-open')).toBeNull();
    expect(within(menu).getByTestId('menu-turn-on')).toHaveTextContent('Turn on all 2');
    expect(within(menu).getByTestId('menu-delete')).toHaveTextContent('Delete all 3');
    await act(async () => {
      fireEvent.click(within(menu).getByTestId('menu-turn-on'));
    });
    expect(actions.setLive.mock.calls).toEqual([
      ['a2', true],
      ['a3', true],
    ]);
  });
});
