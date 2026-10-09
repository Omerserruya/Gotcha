import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { automationSchema, catalogSchema } from '@/api/contracts/automations';
import automationsMessages from '@/i18n/messages/en/automations.json';
import commonMessages from '@/i18n/messages/en/common.json';

import { duplicateStep, removeSteps } from './graph';

/**
 * ★★ 09d with the keyboard and the right button (Omer, 2026-10-07): pick
 * steps, remove them by the "Remove step" rules (asked when more than one
 * goes, never the trigger), undo, publish with ⌘/Ctrl+S, right-click a step
 * or the canvas - and nothing fires while typing.
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
const actions = vi.hoisted(() => ({
  setLive: vi.fn(),
  readCatalog: vi.fn(),
  createAutomation: vi.fn(),
  publishAutomation: vi.fn(),
  readRuns: vi.fn(),
  readRun: vi.fn(),
  provisionWebhook: vi.fn(),
  deleteAutomation: vi.fn(),
  checkGraph: vi.fn(),
}));
vi.mock('./automation-actions', () => actions);

const { Builder } = await import('./Builder');

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const edge = (id: string, source: string, target: string, sourceHandle: string | null = null) => ({
  id,
  source,
  target,
  sourceHandle,
});
const GRAPH = {
  nodes: [
    node('t', 'automation_trigger'),
    node('tag', 'add_tag', { tag: 'vip' }),
    node('w', 'wait', { durationMs: 3_600_000 }),
    node('m', 'send_message_text', { text: 'Hi' }),
  ],
  edges: [edge('e1', 't', 'tag'), edge('e2', 'tag', 'w'), edge('e3', 'w', 'm')],
};
const automation = (status: 'draft' | 'live') =>
  automationSchema.parse({
    id: 'a1',
    name: 'Tagged',
    description: null,
    trigger: { type: 'tag_added', config: { tags: ['vip'] } },
    status,
    path: [],
    stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
    updatedAt: '2026-10-06T09:00:00Z',
    ...GRAPH,
  });
const catalog = catalogSchema.parse({
  data: {
    context: { channel: null, firstStep: false, hasCustomer: true, afterNodeType: null },
    groups: [],
    variables: [],
  },
}).data;

const show = (status: 'draft' | 'live' = 'draft') =>
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Jerusalem"
      now={new Date('2026-10-06T10:00:00Z')}
      messages={{ automations: automationsMessages, common: commonMessages }}
    >
      <Builder
        automation={automation(status)}
        catalog={catalog}
        stats={{}}
        webhook={null}
        choices={{ employees: [], teams: [], members: [], skills: [] }}
      />
    </NextIntlClientProvider>,
  );

const card = (id: string) => screen.getByTestId(`node-${id}`);
const has = (id: string) => screen.queryByTestId(`node-${id}`) !== null;
const key = (k: string, mod = false, target: Window | Element = window) =>
  act(() => {
    fireEvent.keyDown(target, { key: k, ctrlKey: mod });
  });

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.checkGraph.mockResolvedValue(null);
});

describe('the rules, on the graph', () => {
  it('removeSteps: each by removeStep, the trigger never', () => {
    const next = removeSteps(GRAPH, ['t', 'tag', 'w']);
    expect(next.nodes.map((n) => n.id)).toEqual(['t', 'm']);
    expect(next.edges).toEqual([edge('e1', 't', 'm')]);
  });

  it('duplicateStep: a step with one way on, right after itself, leading where it led', () => {
    let n = 0;
    const made = duplicateStep(GRAPH, 'tag', () => `x${++n}`)!;
    expect(made.graph.nodes.find((x) => x.id === made.id)?.data).toEqual({ tag: 'vip' });
    expect(made.graph.edges).toContainEqual(edge('x2', 'tag', made.id));
    expect(made.graph.edges).toContainEqual(edge('e2', made.id, 'w'));
    expect(duplicateStep(GRAPH, 't', () => 'y')).toBeNull();
  });
});

describe('★★ 09d keys', () => {
  it('Delete removes the open step; ⌘/Ctrl+Z puts it back', () => {
    show();
    fireEvent.click(card('w'));
    key('Delete');
    expect(has('w')).toBe(false);
    expect(has('m')).toBe(true);
    key('z', true);
    expect(has('w')).toBe(true);
  });

  it('★ Shift-click picks several; removing more than one is asked, naming the count', () => {
    show();
    fireEvent.click(card('tag'));
    fireEvent.click(card('w'), { shiftKey: true });
    key('Backspace');
    expect(screen.getByTestId('builder-remove-many')).toHaveTextContent('Remove 2 steps?');
    expect(has('tag')).toBe(true);
    fireEvent.click(screen.getByTestId('builder-remove-many-yes'));
    expect(has('tag')).toBe(false);
    expect(has('w')).toBe(false);
    expect(has('m')).toBe(true);
  });

  it('⌘/Ctrl+A picks every step but the trigger; Delete never removes the trigger', () => {
    show();
    key('a', true);
    key('Delete');
    expect(screen.getByTestId('builder-remove-many')).toHaveTextContent('Remove 3 steps?');
    fireEvent.click(screen.getByTestId('builder-remove-many-yes'));
    expect(has('t')).toBe(true);
    fireEvent.click(card('t'));
    key('Delete');
    expect(has('t')).toBe(true);
  });

  it('Esc clears the selection and closes the inspector', () => {
    show();
    fireEvent.click(card('w'));
    expect(screen.getByTestId('inspector')).toBeInTheDocument();
    key('Escape');
    expect(screen.queryByTestId('inspector')).toBeNull();
  });

  it('★ ⌘/Ctrl+S publishes as the button does: a draft is asked first', async () => {
    show('draft');
    fireEvent.click(card('w'));
    key('Delete');
    key('s', true);
    expect(screen.getByTestId('builder-turn-on')).toBeInTheDocument();
    expect(actions.publishAutomation).not.toHaveBeenCalled();
  });

  it('★ nothing fires while typing in a field', () => {
    show();
    fireEvent.click(card('w'));
    const field = screen.getByTestId('inspector-label');
    key('Delete', false, field);
    key('a', true, field);
    key('s', true, field);
    expect(has('w')).toBe(true);
    expect(screen.queryByTestId('builder-turn-on')).toBeNull();
  });

  it('? opens the list of shortcuts', () => {
    show();
    key('?');
    expect(screen.getByTestId('builder-keys-list')).toHaveTextContent('Undo the last change');
  });
});

describe('★★ 09d right-click', () => {
  const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });

  it('on a step: Edit, Duplicate, Remove step - Duplicate puts a copy right after it', () => {
    show();
    rightClick(card('tag'));
    const menu = screen.getByTestId('builder-menu');
    expect(within(menu).getByTestId('menu-edit')).toBeInTheDocument();
    expect(within(menu).getByTestId('menu-remove')).toHaveTextContent('Remove step');
    fireEvent.click(within(menu).getByTestId('menu-duplicate'));
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(5);
  });

  it('on the trigger: no Remove, no Duplicate', () => {
    show();
    rightClick(card('t'));
    const menu = screen.getByTestId('builder-menu');
    expect(within(menu).queryByTestId('menu-remove')).toBeNull();
    expect(within(menu).queryByTestId('menu-duplicate')).toBeNull();
  });

  it('on the canvas: Add a step here (09e), Select all', async () => {
    actions.readCatalog.mockResolvedValue(catalog);
    show();
    rightClick(screen.getByTestId('builder-canvas'));
    const menu = screen.getByTestId('builder-menu');
    expect(within(menu).getByTestId('menu-select-all')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(menu).getByTestId('menu-add-here'));
    });
    expect(actions.readCatalog).toHaveBeenCalledWith({ automationId: 'a1', after: 'm' });
  });
});
