import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  automationSchema,
  catalogSchema,
  issueSchema,
  type Automation,
  type Catalog,
} from '@/api/contracts/automations';
import plateStyles from '@/design-system/brand/channel-plate.module.css';
import automationsMessages from '@/i18n/messages/en/automations.json';
import commonMessages from '@/i18n/messages/en/common.json';
import heAutomationsMessages from '@/i18n/messages/he/automations.json';
import heCommonMessages from '@/i18n/messages/he/common.json';

const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push, replace }),
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

import { AutomationsList } from './AutomationsList';
import { Builder } from './Builder';
import { NewAutomation } from './NewAutomation';
import { NodeCard } from './NodeCard';
import { StepSheet } from './StepSheet';

const NOW = new Date('2026-10-06T10:00:00Z');
const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Jerusalem"
      now={NOW}
      messages={{ automations: automationsMessages, common: commonMessages }}
    >
      {node}
    </NextIntlClientProvider>,
  );

const automation = (over: Record<string, unknown> = {}): Automation =>
  automationSchema.parse({
    id: 'a1',
    name: 'A call is missed',
    description: null,
    trigger: { type: 'call_missed', config: {} },
    status: 'live',
    path: [
      { nodeId: 't', type: 'automation_trigger', label: 'Call missed' },
      { nodeId: 'h', type: 'opening_hours', label: 'Open now?' },
      { nodeId: 'b', type: 'send_buttons', label: 'Buttons' },
    ],
    stats: { runsThisWeek: 86, lastRunAt: '2026-10-06T09:58:00Z', lastRunStatus: 'completed' },
    updatedAt: '2026-10-06T09:00:00Z',
    ...over,
  });

const item = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  label: type,
  description: '',
  channels: [],
  outputs: ['next'],
  synonyms: [],
  available: true,
  reason: null,
  ...over,
});
const catalog = (firstStep: boolean): Catalog =>
  catalogSchema.parse({
    data: {
      context: { channel: null, firstStep, hasCustomer: true, afterNodeType: null },
      groups: [
        {
          key: 'trigger',
          items: [
            item('trigger:schedule', {
              available: firstStep,
              reason: firstStep ? null : 'first_step_only',
            }),
            item('trigger:order_event', { available: false, reason: 'no_event_source' }),
          ],
        },
        {
          key: 'logic',
          items: [
            item('wait', { available: !firstStep, reason: firstStep ? 'first_step_only' : null }),
          ],
        },
        {
          key: 'send',
          items: [
            item('send_buttons', {
              synonyms: ['quick reply', 'options'],
              channels: ['WHATSAPP', 'INSTAGRAM'],
              available: !firstStep,
              reason: firstStep ? 'first_step_only' : null,
            }),
            item('send_location', { available: false, reason: 'coming_later' }),
          ],
        },
        {
          key: 'do',
          items: [
            item('add_tag', {
              available: !firstStep,
              reason: firstStep ? 'first_step_only' : null,
            }),
          ],
        },
      ],
      variables: ['first_name', 'business_name'],
    },
  }).data;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.checkGraph.mockResolvedValue(null);
  push.mockReset();
  replace.mockReset();
});

describe("★★ 09c - the table is the route's", () => {
  it("a catalogue-named step in our words; an author's own label as written", () => {
    wrap(<AutomationsList automations={[automation()]} />);
    const path = screen.getByTestId('automation-path-a1');
    expect(path).toHaveTextContent('Call missed');
    expect(path).toHaveTextContent('Open now?');
    expect(path).toHaveTextContent('Buttons');
    expect(screen.getByTestId('automation-week-a1')).toHaveTextContent('86 runs');
    expect(screen.getByTestId('automation-open-a1')).toHaveAttribute(
      'href',
      '/studio/automations/a1',
    );
  });

  it('never run: "No runs yet", and no number for the week', () => {
    wrap(
      <AutomationsList
        automations={[
          automation({ stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null } }),
        ]}
      />,
    );
    expect(screen.getByTestId('automation-last-a1')).toHaveTextContent('No runs yet');
    expect(screen.getByTestId('automation-week-a1').textContent).toBe('');
  });

  it('paused: when, and by whom', () => {
    wrap(
      <AutomationsList
        automations={[
          automation({
            status: 'paused',
            pausedAt: '2026-08-12T10:00:00Z',
            pausedBy: { id: 'u1', name: 'Omer' },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('automation-last-a1')).toHaveTextContent('Paused Aug 12 by Omer');
    expect(screen.getByTestId('automation-switch-a1')).not.toBeChecked();
  });

  it("on: refused with the validator's code, said in our words, with the way in", async () => {
    actions.setLive.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      errors: [
        issueSchema.parse({
          severity: 'error',
          code: 'no_steps',
          message: 'Add a step after the trigger.',
        }),
      ],
    });
    wrap(<AutomationsList automations={[automation({ status: 'draft' })]} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-switch-a1'));
    });
    expect(actions.setLive).toHaveBeenCalledWith('a1', true);
    expect(screen.getByTestId('automation-refused-a1')).toHaveTextContent(
      "It can't go live yet: it has no steps after the trigger",
    );
    expect(screen.getByTestId('automation-switch-a1')).not.toBeChecked();
  });

  it('off: pauses, and the row says so', async () => {
    actions.setLive.mockResolvedValue({
      ok: true,
      warnings: [],
      automation: automation({
        status: 'paused',
        pausedAt: '2026-10-06T10:00:00Z',
        pausedBy: { id: 'u1', name: 'Omer' },
      }),
    });
    wrap(<AutomationsList automations={[automation()]} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('automation-switch-a1'));
    });
    expect(actions.setLive).toHaveBeenCalledWith('a1', false);
    expect(screen.getByTestId('automation-last-a1')).toHaveTextContent('Paused Oct 6 by Omer');
  });
});

describe('★★ 09e - every step, dimmed where it cannot run, with why', () => {
  it('mid-path: triggers keep their line under "first step only"; another reason replaces the line', () => {
    wrap(
      <StepSheet catalog={catalog(false)} context="After x" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('step-trigger:schedule')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('step-trigger:schedule')).toHaveTextContent('Daily, weekly, a date');
    expect(screen.getByTestId('step-send_location')).toHaveTextContent('Coming later');
    // Being built: tagged, and not a button.
    expect(screen.getByTestId('step-send_location')).toHaveTextContent('Coming soon');
    expect(screen.getByTestId('step-send_location').tagName).toBe('DIV');
    expect(screen.getByTestId('step-send_buttons')).toBeEnabled();
  });

  it('search matches what people say, not ids', () => {
    wrap(
      <StepSheet catalog={catalog(false)} context="After x" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('step-search'), { target: { value: 'quick reply' } });
    expect(screen.getByTestId('step-send_buttons')).toBeInTheDocument();
    expect(screen.queryByTestId('step-add_tag')).toBeNull();
  });

  it('unread is said, not an empty sheet', () => {
    wrap(<StepSheet catalog={null} context="After x" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('step-sheet-unread')).toBeInTheDocument();
  });
});

describe('★★ New automation - a trigger, what it cannot go without, then the builder', () => {
  it('On a schedule asks the time; creates a draft with it; opens the builder', async () => {
    actions.createAutomation.mockResolvedValue({
      ok: true,
      automation: automation({ id: 'new1', status: 'draft' }),
    });
    wrap(<NewAutomation catalog={catalog(true)} />);
    expect(screen.getByTestId('step-add_tag')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByTestId('step-trigger:schedule'));
    expect(screen.getByTestId('new-automation-name')).toHaveValue('On a schedule');
    fireEvent.change(screen.getByTestId('new-automation-at'), { target: { value: '08:30' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    expect(actions.createAutomation).toHaveBeenCalledWith({
      name: 'On a schedule',
      trigger: { type: 'schedule', config: { at: '08:30' } },
    });
    expect(push).toHaveBeenCalledWith('/studio/automations/new1');
  });

  it('★ in Hebrew the draft is named in Hebrew - a trigger and a template alike', async () => {
    actions.createAutomation.mockResolvedValue({
      ok: true,
      automation: automation({ id: 'he1', status: 'draft' }),
    });
    const inHebrew = (node: ReactNode) =>
      render(
        <NextIntlClientProvider
          locale="he"
          timeZone="Asia/Jerusalem"
          now={NOW}
          messages={{ automations: heAutomationsMessages, common: heCommonMessages }}
        >
          {node}
        </NextIntlClientProvider>,
      );
    const picked = inHebrew(<NewAutomation catalog={catalog(true)} />);
    fireEvent.click(screen.getByTestId('step-trigger:schedule'));
    expect(screen.getByTestId('new-automation-name')).toHaveValue(
      heAutomationsMessages.nodes.trigger.schedule,
    );
    picked.unmount();
    inHebrew(<NewAutomation catalog={null} templateKey="comment" />);
    expect(screen.getByTestId('new-automation-name')).toHaveValue('תגובה על פוסט ← הודעה פרטית');
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    expect(actions.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'תגובה על פוסט ← הודעה פרטית' }),
    );
  });

  it('refused: says why, stays', async () => {
    actions.createAutomation.mockResolvedValue({ ok: false, reason: 'limit' });
    wrap(<NewAutomation catalog={catalog(true)} />);
    fireEvent.click(screen.getByTestId('step-trigger:schedule'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    expect(screen.getByTestId('new-automation-failed')).toHaveTextContent('no room');
    expect(push).not.toHaveBeenCalled();
  });
});

describe('★★ 09d - the builder', () => {
  const draft = () =>
    automation({
      status: 'draft',
      stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
      nodes: [{ id: 't', type: 'automation_trigger', data: {} }],
      edges: [],
    });
  const show = (a = draft()) =>
    wrap(
      <Builder
        automation={a}
        catalog={catalog(false)}
        stats={{}}
        webhook={null}
        choices={{ employees: [], teams: [], members: [], skills: [] }}
      />,
    );

  it('a "+" on the free output opens 09e for that spot; a step chosen goes there', async () => {
    actions.readCatalog.mockResolvedValue(catalog(false));
    show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-t-next'));
    });
    expect(actions.readCatalog).toHaveBeenCalledWith({ automationId: 'a1', after: 't' });
    fireEvent.click(screen.getByTestId('step-add_tag'));
    expect(screen.getByTestId('inspector-tag')).toBeInTheDocument();
    expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
  });

  it('Publish: a draft saved but not live says why, and marks the step', async () => {
    actions.publishAutomation.mockResolvedValue({
      ok: true,
      live: false,
      warnings: [],
      blocked: [
        issueSchema.parse({ severity: 'error', code: 'no_steps', nodeId: 't', message: 'x' }),
      ],
      automation: draft(),
    });
    show();
    // A draft's publish turns it on: said first, by what starts it.
    expect(screen.getByTestId('builder-publish')).toHaveTextContent('Publish and turn on');
    fireEvent.click(screen.getByTestId('builder-publish'));
    expect(actions.publishAutomation).not.toHaveBeenCalled();
    expect(screen.getByTestId('builder-turn-on')).toHaveTextContent(
      'From now on, every time a call is missed, this runs.',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('builder-turn-on-yes'));
    });
    expect(actions.publishAutomation).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({
        expectedUpdatedAt: '2026-10-06T09:00:00Z',
        name: 'A call is missed',
      }),
    );
    expect(screen.getByTestId('builder-outcome')).toHaveTextContent('Saved as a draft');
    expect(screen.getByTestId('builder-outcome')).toHaveTextContent(
      'it has no steps after the trigger',
    );
    expect(screen.getByTestId('node-t')).toHaveAttribute('data-marked');
  });

  it('★ AU6: nothing chosen - a library step goes after the last step, and it says where', () => {
    const line = automation({
      status: 'draft',
      stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
      nodes: [
        { id: 't', type: 'automation_trigger', data: {} },
        { id: 'a', type: 'add_tag', data: { tag: 'vip' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a', sourceHandle: null }],
    });
    show(line);
    expect(screen.getByTestId('library-where')).toHaveTextContent(/^Adds after/);
    expect(screen.getByTestId('library-add_tag')).toBeEnabled();
    fireEvent.click(screen.getByTestId('library-add_tag'));
    // The new step is after "a": the canvas has three steps, and a's way out is used.
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
    expect(screen.queryByTestId('add-a-next')).toBeNull();
    expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
  });

  it('★ AU6: every way out taken - said, and nothing to press', () => {
    const closed = automation({
      status: 'draft',
      stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
      nodes: [
        { id: 't', type: 'automation_trigger', data: {} },
        { id: 'x', type: 'close_conversation', data: {} },
      ],
      edges: [{ id: 'e1', source: 't', target: 'x', sourceHandle: null }],
    });
    show(closed);
    expect(screen.getByTestId('library-where')).toHaveTextContent(
      "Every step's ways out are taken",
    );
    expect(screen.getByTestId('library-add_tag')).toBeDisabled();
  });

  it('★ AU6: an unavailable step says why in words; "Coming later" is its tag alone', () => {
    const why = catalogSchema.parse({
      data: {
        context: { channel: 'WHATSAPP', firstStep: false, hasCustomer: true, afterNodeType: null },
        groups: [
          {
            key: 'send',
            items: [
              item('send_text', { available: false, reason: 'needs_24h_window' }),
              item('send_location', { available: false, reason: 'coming_later' }),
            ],
          },
        ],
        variables: [],
      },
    }).data;
    wrap(
      <Builder
        automation={draft()}
        catalog={why}
        stats={{}}
        webhook={null}
        choices={{ employees: [], teams: [], members: [], skills: [] }}
      />,
    );
    expect(screen.getByTestId('library-send_text-why')).toHaveTextContent(
      'Needs the 24-hour window: use a template',
    );
    expect(screen.queryByTestId('library-send_location-why')).toBeNull();
  });

  describe('★★ AU6 step 2: drag a step from the library', () => {
    const transfer = () => ({
      data: {} as Record<string, string>,
      setData(k: string, v: string) {
        this.data[k] = v;
      },
      getData(k: string) {
        return this.data[k] ?? '';
      },
      effectAllowed: 'all',
      dropEffect: 'none',
    });
    const line = () =>
      automation({
        status: 'draft',
        stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
        nodes: [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'a', type: 'add_tag', data: { tag: 'vip' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'a', sourceHandle: null }],
      });
    const drag = (onto: string) => {
      const dataTransfer = transfer();
      fireEvent.dragStart(screen.getByTestId('library-wait'), { dataTransfer });
      // A browser drops only where dragover was refused its default.
      expect(fireEvent.dragOver(screen.getByTestId(onto), { dataTransfer })).toBe(false);
      fireEvent.drop(screen.getByTestId(onto), { dataTransfer });
    };

    it('onto a free "+": after that step', () => {
      show(draft());
      drag('add-t-next');
      expect(screen.getAllByTestId(/^node-/)).toHaveLength(2);
      expect(screen.queryByTestId('add-t-next')).toBeNull();
      expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
    });

    it('onto one branch\'s "+": that branch only - never also where a canvas drop would go', () => {
      const split = automation({
        status: 'draft',
        stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
        nodes: [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'h', type: 'opening_hours', data: {} },
          { id: 'a', type: 'add_tag', data: { tag: 'vip' } },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'h', sourceHandle: null },
          { id: 'e2', source: 'h', target: 'a', sourceHandle: 'open' },
        ],
      });
      show(split);
      drag('add-h-closed');
      expect(screen.getAllByTestId(/^node-/)).toHaveLength(4);
      expect(screen.queryByTestId('add-h-closed')).toBeNull();
      // The canvas's own spot - after "a" - is untouched.
      expect(screen.getByTestId('add-a-next')).toBeInTheDocument();
    });

    it('onto a line\'s "+": between the two steps', () => {
      show(line());
      drag('between-t-a');
      expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
      // The line t → a is now t → new → a.
      expect(screen.queryByTestId('between-t-a')).toBeNull();
      expect(screen.getAllByTestId(/^between-/)).toHaveLength(2);
    });

    it('anywhere else on the canvas: where a click would put it (after the last step)', () => {
      show(line());
      drag('builder-canvas-area');
      expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
      expect(screen.queryByTestId('add-a-next')).toBeNull();
      expect(screen.getByTestId('between-t-a')).toBeInTheDocument();
    });

    it('while it moves the canvas says where it may land; the end of the drag clears it', () => {
      show(line());
      const dataTransfer = transfer();
      fireEvent.dragStart(screen.getByTestId('library-wait'), { dataTransfer });
      expect(screen.getByTestId('builder-canvas-area')).toHaveAttribute('data-dragging');
      expect(screen.getByTestId('library-wait')).toHaveAttribute('draggable', 'true');
      fireEvent.dragEnd(screen.getByTestId('library-wait'), { dataTransfer });
      expect(screen.getByTestId('builder-canvas-area')).not.toHaveAttribute('data-dragging');
    });

    it('a drop that did not start in the library adds nothing', () => {
      show(line());
      const dataTransfer = transfer();
      fireEvent.dragOver(screen.getByTestId('builder-canvas-area'), { dataTransfer });
      fireEvent.drop(screen.getByTestId('builder-canvas-area'), { dataTransfer });
      expect(screen.getAllByTestId(/^node-/)).toHaveLength(2);
    });
  });

  it('Test is drawn, off, saying why; never run says so', () => {
    show();
    expect(screen.getByTestId('builder-test')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('builder-test').tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('inspector-stats')).toHaveTextContent('No runs yet');
  });

  it('Run log: nothing has run - "No runs yet", never a number', async () => {
    actions.readRuns.mockResolvedValue({ runs: [], nextCursor: null });
    show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('builder-run-log'));
    });
    expect(screen.getByTestId('run-log-empty')).toHaveTextContent('No runs yet');
  });
});

describe('★ measured on dev (e6785c4)', () => {
  const live = () =>
    automation({ nodes: [{ id: 't', type: 'automation_trigger', data: {} }], edges: [] });
  const showBuilder = (a: Automation) =>
    wrap(
      <Builder
        automation={a}
        catalog={catalog(false)}
        stats={{}}
        webhook={null}
        choices={{ employees: [], teams: [], members: [], skills: [] }}
      />,
    );

  it('live: "Publish changes", no confirmation', async () => {
    actions.publishAutomation.mockResolvedValue({ ok: false, reason: 'failed' });
    showBuilder(live());
    fireEvent.change(screen.getByTestId('builder-name'), { target: { value: 'Renamed' } });
    expect(screen.getByTestId('builder-publish')).toHaveTextContent('Publish changes');
    await act(async () => {
      fireEvent.click(screen.getByTestId('builder-publish'));
    });
    expect(screen.queryByTestId('builder-turn-on')).toBeNull();
    expect(actions.publishAutomation).toHaveBeenCalled();
  });

  it('09d: Delete, confirmed, saying the run history goes too; then back to 09c', async () => {
    actions.deleteAutomation.mockResolvedValue(true);
    showBuilder(live());
    fireEvent.keyDown(screen.getByTestId('builder-more'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('builder-delete'));
    expect(screen.getByTestId('delete-automation')).toHaveTextContent(
      'together with its run history',
    );
    expect(actions.deleteAutomation).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(actions.deleteAutomation).toHaveBeenCalledWith('a1');
    expect(push).toHaveBeenCalledWith('/studio/automations?deleted=1');
  });

  it('09c: Delete from the row; the row goes; refused, it stays and says so', async () => {
    actions.deleteAutomation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    wrap(<AutomationsList automations={[automation()]} />);
    fireEvent.keyDown(screen.getByTestId('automation-more-a1'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('automation-delete-a1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(screen.getByTestId('delete-automation-failed')).toBeInTheDocument();
    expect(screen.getByTestId('automation-a1')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(screen.queryByTestId('automation-a1')).toBeNull();
  });

  it('a trigger step reads TRIGGER, singular', () => {
    wrap(
      <NodeCard
        node={live().nodes![0]!}
        trigger={live().trigger}
        selected={false}
        marked={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('node-t')).toHaveTextContent(/^Trigger · Call missed/);
  });

  it('★★ a step’s channels: each its own mark on the shared plate, named once in words', () => {
    wrap(<StepSheet catalog={catalog(false)} context="x" onPick={vi.fn()} onClose={vi.fn()} />);
    const plates = [
      ...screen.getByTestId('step-send_buttons').querySelectorAll('[data-channel-plate]'),
    ];
    expect(plates.map((plate) => plate.querySelector('svg')?.getAttribute('data-glyph'))).toEqual([
      'whatsapp',
      'instagram',
    ]);
    for (const plate of plates) expect(plate.classList).toContain(plateStyles.plate);
    // The row of them is one image, named in words; each plate is decorative.
    expect(
      within(screen.getByTestId('step-send_buttons')).getByRole('img', {
        name: 'WhatsApp, Instagram',
      }),
    ).toBeInTheDocument();
  });

  it('★★ a row whose trigger names one channel wears it on the shared plate', () => {
    wrap(
      <AutomationsList
        automations={[
          automation({ trigger: { type: 'message_received', config: { channels: ['WHATSAPP'] } } }),
        ]}
      />,
    );
    const plate = screen.getByTestId('automation-a1').querySelector('[data-channel-plate]');
    expect(plate).toHaveAttribute('data-channel-plate', 'lg');
    expect(plate?.classList).toContain(plateStyles.plate);
    expect(plate?.querySelector('svg')).toHaveAttribute('data-glyph', 'whatsapp');
    // Decorative, as the tile was: the automation's name is the row's name.
    expect(plate?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('the builder library: an icon per step', () => {
    showBuilder(live());
    expect(screen.getByTestId('library-send_buttons').querySelector('svg')).not.toBeNull();
  });
});

describe('★★ a template creates a real draft - its graph sent, never turned on', () => {
  it('the welcome: the trigger, the graph with the greeting by name; then the builder', async () => {
    actions.createAutomation.mockResolvedValue({
      ok: true,
      automation: automation({ id: 'w1', status: 'draft' }),
    });
    wrap(<NewAutomation catalog={null} templateKey="welcome" />);
    expect(screen.getByTestId('new-automation-name')).toHaveValue('Welcome a new customer');
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    const sent = actions.createAutomation.mock.calls[0]![0] as {
      trigger: { type: string };
      nodes: { type: string; data: Record<string, unknown> }[];
      edges: unknown[];
    };
    expect(sent.trigger.type).toBe('new_customer');
    expect(sent.nodes.map((x) => x.type)).toEqual(['automation_trigger', 'send_message_text']);
    expect(sent.nodes[1]!.data.text).toBe(
      'Hi {{first_name}}, thanks for writing to us. How can we help?',
    );
    expect(sent.edges).toHaveLength(1);
    expect(push).toHaveBeenCalledWith('/studio/automations/w1');
  });

  it('tag added: still asks for the tags the route needs', async () => {
    wrap(<NewAutomation catalog={null} templateKey="tagNotify" />);
    expect(screen.getByTestId('new-automation-create')).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-automation-tags'), { target: { value: 'vip' } });
    expect(screen.getByTestId('new-automation-create')).toBeEnabled();
  });
});

describe('★★ the new triggers and steps (Backend 972ae66d), edited where they are set', () => {
  const draftOf = (
    trigger: Record<string, unknown>,
    nodes: unknown[] = [{ id: 't', type: 'automation_trigger', data: {} }],
    edges: unknown[] = [],
  ) =>
    automation({
      status: 'draft',
      trigger,
      nodes,
      edges,
      stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
    });
  const showBuilder = (
    a: Automation,
    templates: { id: string; name: string; variables: string[] }[] = [],
  ) =>
    wrap(
      <Builder
        automation={a}
        catalog={catalog(false)}
        stats={{}}
        webhook={null}
        choices={{
          employees: [{ id: 'e1', name: 'Shira' }],
          teams: [],
          members: [],
          skills: [],
          templates,
        }}
      />,
    );

  it('cart left behind: no channels (its first message names it), the delay in hours, who it sends to', () => {
    showBuilder(draftOf({ type: 'cart_abandoned', config: { delayMinutes: 120 } }));
    // AU4 (Backend 0c410009): the channel belongs to the first message.
    expect(screen.queryByTestId('inspector-channel-WHATSAPP')).toBeNull();
    expect(screen.queryByTestId('inspector-channel-EMAIL')).toBeNull();
    expect(screen.getByTestId('inspector-cart-channel')).toHaveTextContent(
      "The channel is the first message's",
    );
    expect(screen.getByTestId('inspector-cart-delay')).toHaveValue(2);
    expect(screen.getByTestId('inspector-cart-consent')).toHaveTextContent('agreed to marketing');
  });

  describe("★★ AU4: a cart reminder reaches the customer on its first message's channel", () => {
    const cartDraft = (nodes: unknown[], edges: unknown[]) =>
      draftOf({ type: 'cart_abandoned', config: { delayMinutes: 60 } }, nodes, edges);
    const firstText = [
      { id: 't', type: 'automation_trigger', data: {} },
      { id: 'm', type: 'send_message_text', data: { text: 'Your cart is waiting' } },
    ];
    const toFirst = [{ id: 'e1', source: 't', target: 'm', sourceHandle: null }];

    it("★ the first message: WhatsApp or email; email asks its subject, starting as the automation's name", () => {
      showBuilder(cartDraft(firstText, toFirst));
      fireEvent.click(screen.getByTestId('node-m'));
      fireEvent.click(screen.getByTestId('inspector-via-email'));
      expect(screen.getByTestId('inspector-subject')).toHaveValue('A call is missed');
      fireEvent.change(screen.getByTestId('inspector-subject'), { target: { value: 'Your cart' } });
      expect(screen.getByTestId('inspector-via-email')).toBeChecked();
      expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('inspector-via-whatsapp'));
      expect(screen.queryByTestId('inspector-subject')).toBeNull();
    });

    it('its "if they can\'t be reached" exit is on the canvas, named', () => {
      showBuilder(cartDraft(firstText, toFirst));
      expect(screen.getByTestId('add-m-unreachable')).toHaveAccessibleName(
        "Add a step on Message's If they can't be reached branch",
      );
    });

    it('a channel that cannot reach anyone is offered with why, not chosen', () => {
      const read = catalog(false);
      wrap(
        <Builder
          automation={cartDraft(firstText, toFirst)}
          catalog={{
            ...read,
            context: { ...read.context, reach: { whatsapp: true, email: false } },
          }}
          stats={{}}
          webhook={null}
          choices={{ employees: [], teams: [], members: [], skills: [] }}
        />,
      );
      fireEvent.click(screen.getByTestId('node-m'));
      expect(screen.getByTestId('inspector-via-email')).toBeDisabled();
      expect(screen.getByTestId('inspector-via-email').closest('label')).toHaveTextContent(
        'Email: not connected',
      );
      expect(screen.getByTestId('inspector-via-whatsapp')).toBeEnabled();
    });

    it("the step on the exit says it is the other channel's try, and names its own", () => {
      showBuilder(
        cartDraft(
          [...firstText, { id: 'e', type: 'send_message_text', data: { text: 'By email' } }],
          [...toFirst, { id: 'e2', source: 'm', target: 'e', sourceHandle: 'unreachable' }],
        ),
      );
      fireEvent.click(screen.getByTestId('node-e'));
      expect(screen.getByTestId('inspector-fallback-note')).toHaveTextContent("can't reach them");
      expect(screen.getByTestId('inspector-via-email')).toBeInTheDocument();
    });

    it('a template first says it goes on WhatsApp; a later message names no channel', () => {
      showBuilder(
        cartDraft(
          [
            { id: 't', type: 'automation_trigger', data: {} },
            { id: 'p', type: 'send_message_template', data: {} },
            { id: 'n', type: 'send_message_text', data: { text: 'later' } },
          ],
          [
            { id: 'e1', source: 't', target: 'p', sourceHandle: null },
            { id: 'e2', source: 'p', target: 'n', sourceHandle: null },
          ],
        ),
      );
      fireEvent.click(screen.getByTestId('node-p'));
      expect(screen.getByTestId('inspector-template-whatsapp')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('node-n'));
      expect(screen.queryByTestId('inspector-via-whatsapp')).toBeNull();
    });

    it('not a cart reminder: no channel on a message', () => {
      showBuilder(draftOf({ type: 'message_received', config: {} }, firstText, toFirst));
      fireEvent.click(screen.getByTestId('node-m'));
      expect(screen.queryByTestId('inspector-via-whatsapp')).toBeNull();
      expect(screen.queryByTestId('add-m-unreachable')).toBeNull();
    });
  });

  it('order event: where it sends, which events, and that WhatsApp takes a template only', () => {
    showBuilder(draftOf({ type: 'order_event', config: {} }));
    expect(screen.getByTestId('inspector-channel-WHATSAPP')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-channel-EMAIL')).toBeInTheDocument();
    for (const status of ['created', 'paid', 'fulfilled', 'cancelled']) {
      expect(screen.getByTestId(`inspector-order-${status}`)).not.toBeChecked();
    }
    fireEvent.click(screen.getByTestId('inspector-order-fulfilled'));
    expect(screen.getByTestId('inspector-order-fulfilled')).toBeChecked();
    expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-order-template-only')).toHaveTextContent(
      'only an approved template',
    );
  });

  it('story mention: no settings, and it says what it covers', () => {
    showBuilder(draftOf({ type: 'story_mention', config: {} }));
    expect(screen.getByTestId('inspector-story-mention')).toHaveTextContent('Instagram only');
    expect(screen.queryByText('This trigger has nothing to set.')).toBeNull();
  });

  it('message from an ad: the ads as a list, saved as items', () => {
    showBuilder(draftOf({ type: 'message_from_ad', config: {} }));
    fireEvent.change(screen.getByTestId('inspector-ad-ids'), { target: { value: '123, 456' } });
    expect(screen.getByTestId('builder-unsaved')).toBeInTheDocument();
  });

  it('send template: an approved one, and a field per variable', () => {
    showBuilder(
      draftOf(
        { type: 'cart_abandoned', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 's', type: 'send_message_template', data: { templateId: '', variables: {} } },
        ],
        [{ id: 'e', source: 't', target: 's', sourceHandle: null }],
      ),
      [{ id: 'tpl1', name: 'Cart reminder', variables: ['1', '2'] }],
    );
    expect(screen.getByTestId('to-fill-s')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('node-s'));
    fireEvent.change(screen.getByTestId('inspector-template'), { target: { value: 'tpl1' } });
    expect(screen.getByTestId('inspector-template-var-1')).toBeInTheDocument();
    expect(screen.queryByTestId('to-fill-s')).toBeNull();
  });

  it('★★ AU5: an edge starts at its card’s measured bottom edge - never a fixed 112px in mid-air', async () => {
    const tall = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80);
    const { container } = showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 's', type: 'send_message_text', data: { text: 'hi' } },
        ],
        [{ id: 'e', source: 't', target: 's', sourceHandle: null }],
      ),
    );
    // Card tops sit 20px into their row; the trigger's row is 0: 20 + 80.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="builder-canvas"] > svg path')?.getAttribute('d'),
      ).toMatch(/^M [\d.]+ 100 /),
    );
    tall.mockRestore();
  });

  it('★★ AU8: a step changes type in its place; one it may not become says why, and nothing changes', async () => {
    showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'm', type: 'send_message_text', data: { text: 'hi' } },
          {
            id: 'b',
            type: 'send_buttons',
            data: { text: 'pick', buttons: [{ id: 'x', title: 'X' }] },
          },
          { id: 'w', type: 'wait_for_reply', data: {} },
        ],
        [
          { id: 'e1', source: 't', target: 'm', sourceHandle: null },
          { id: 'e2', source: 'm', target: 'b', sourceHandle: null },
          { id: 'e3', source: 'b', target: 'w', sourceHandle: null },
        ],
      ),
    );
    fireEvent.click(screen.getByTestId('node-m'));
    fireEvent.change(screen.getByTestId('inspector-type'), { target: { value: 'send_buttons' } });
    await waitFor(() => {
      const graph = actions.checkGraph.mock.calls.at(-1)?.[1] as
        | { nodes: { id: string; type: string; data: Record<string, unknown> }[]; edges: unknown[] }
        | undefined;
      expect(graph?.nodes.find((n) => n.id === 'm')).toMatchObject({
        type: 'send_buttons',
        data: { text: 'hi' },
      });
      expect(graph?.edges).toHaveLength(3);
    });
    fireEvent.click(screen.getByTestId('node-b'));
    fireEvent.change(screen.getByTestId('inspector-type'), { target: { value: 'add_tag' } });
    expect(screen.getByTestId('inspector-type-refused')).toHaveTextContent(
      'A wait for the reply reads this step',
    );
    expect(screen.getByTestId('inspector-type')).toHaveValue('send_buttons');
  });

  it('★★ AU9: a "+" on a line puts a step between the two - the line keeps its id', async () => {
    actions.readCatalog.mockResolvedValue(catalog(false));
    showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'm', type: 'send_message_text', data: { text: 'hi' } },
        ],
        [{ id: 'e1', source: 't', target: 'm', sourceHandle: null }],
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('between-t-m'));
    });
    fireEvent.click(screen.getByTestId('step-add_tag'));
    await waitFor(() => {
      const graph = actions.checkGraph.mock.calls.at(-1)?.[1] as
        | {
            nodes: { id: string; type: string }[];
            edges: { id: string; source: string; target: string }[];
          }
        | undefined;
      const added = graph?.nodes.find((n) => n.type === 'add_tag');
      expect(added).toBeDefined();
      expect(graph?.edges).toContainEqual(
        expect.objectContaining({ id: 'e1', source: 't', target: added!.id }),
      );
      expect(graph?.edges).toContainEqual(
        expect.objectContaining({ source: added!.id, target: 'm' }),
      );
    });
    expect(screen.queryByTestId('builder-insert-refused')).toBeNull();
  });

  it('★★ AU9: between buttons and their wait - refused in words, nothing added', async () => {
    actions.readCatalog.mockResolvedValue(catalog(false));
    showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          {
            id: 'b',
            type: 'send_buttons',
            data: { text: 'pick', buttons: [{ id: 'x', title: 'X' }] },
          },
          { id: 'w', type: 'wait_for_reply', data: {} },
        ],
        [
          { id: 'e1', source: 't', target: 'b', sourceHandle: null },
          { id: 'e2', source: 'b', target: 'w', sourceHandle: null },
        ],
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('between-b-w'));
    });
    fireEvent.click(screen.getByTestId('step-add_tag'));
    expect(screen.getByTestId('builder-insert-refused')).toHaveTextContent(
      'Nothing can go between a message with buttons',
    );
    expect(screen.queryByTestId('builder-unsaved')).toBeNull();
  });

  it('★ AU9: a comment automation, before its first wait - only a step the catalogue calls comment-safe', async () => {
    const read = catalog(false);
    actions.readCatalog.mockResolvedValue(read);
    showBuilder(
      draftOf(
        { type: 'comment_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'm', type: 'send_message_text', data: { text: 'hi' } },
        ],
        [{ id: 'e1', source: 't', target: 'm', sourceHandle: null }],
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('between-t-m'));
    });
    // The catalogue does not call add_tag comment-safe: refused.
    fireEvent.click(screen.getByTestId('step-add_tag'));
    expect(screen.getByTestId('builder-insert-refused')).toHaveTextContent('comment automation');
  });

  it('★ a file step writes the executor’s `filename`; an old draft’s `fileName` is read, then dropped', async () => {
    showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          {
            id: 'f',
            type: 'send_message_file',
            data: { url: 'https://x.test/m.pdf', fileName: 'old.pdf', caption: '' },
          },
        ],
        [{ id: 'e', source: 't', target: 'f', sourceHandle: null }],
      ),
    );
    fireEvent.click(screen.getByTestId('node-f'));
    expect(screen.getByTestId('inspector-file-name')).toHaveValue('old.pdf');
    fireEvent.change(screen.getByTestId('inspector-file-name'), {
      target: { value: 'menu.pdf' },
    });
    await waitFor(() => {
      const graph = actions.checkGraph.mock.calls.at(-1)?.[1] as
        { nodes: { id: string; data: Record<string, unknown> }[] } | undefined;
      const data = graph?.nodes.find((n) => n.id === 'f')?.data;
      expect(data).toMatchObject({ filename: 'menu.pdf' });
      expect(JSON.parse(JSON.stringify(data))).not.toHaveProperty('fileName');
    });
  });

  it('AI writes a message: what, who, and send it (on by default)', () => {
    showBuilder(
      draftOf(
        { type: 'message_received', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'a', type: 'ai_generate', data: { prompt: '', aiAgentId: '', send: true } },
        ],
        [{ id: 'e', source: 't', target: 'a', sourceHandle: null }],
      ),
    );
    fireEvent.click(screen.getByTestId('node-a'));
    expect(screen.getByTestId('inspector-send')).toBeChecked();
    expect(screen.getByTestId('to-fill-a')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('inspector-writer'), { target: { value: 'e1' } });
    expect(screen.queryByTestId('to-fill-a')).toBeNull();
  });

  it('the route refuses a step here: the reason on the step, in our words', async () => {
    vi.useFakeTimers();
    actions.checkGraph.mockResolvedValue({
      errors: [
        issueSchema.parse({
          severity: 'error',
          code: 'needs_24h_window',
          nodeId: 'm',
          message: 'x',
        }),
      ],
      warnings: [],
    });
    showBuilder(
      draftOf(
        { type: 'cart_abandoned', config: {} },
        [
          { id: 't', type: 'automation_trigger', data: {} },
          { id: 'm', type: 'send_message_text', data: { text: 'Hi' } },
        ],
        [{ id: 'e', source: 't', target: 'm', sourceHandle: null }],
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    vi.useRealTimers();
    expect(screen.getByTestId('issue-m')).toHaveTextContent(
      'outside the 24-hour window: use a template',
    );
    expect(screen.getByTestId('node-m')).toHaveAttribute('data-marked');
  });

  describe('★★ AU4 on dev: the variables under a message are words, and insert their token', () => {
    // Every variable the route offers (chatbot automation-catalog.ts variablesFor).
    const SERVER_VARIABLES = [
      'first_name',
      'business_name',
      'opening_hours',
      'cart_url',
      'cart_total',
      'cart_items',
      'story_url',
      'order_number',
      'order_total',
      'order_status',
      'order_items',
      'order_url',
      'caller_number',
      'line_name',
      'call_duration',
      'call_recording_url',
      'comment.text',
      'comment.from.username',
      'comment.postId',
      'comment.postPermalink',
    ];

    it.each([
      ['en', automationsMessages],
      ['he', heAutomationsMessages],
    ] as const)('every one has a label in %s, never its id', (_, messages) => {
      const labels = messages.variables as Record<string, string>;
      for (const v of SERVER_VARIABLES) {
        const label = labels[v.replaceAll('.', '_')];
        expect(label, v).toBeTruthy();
        expect(label).not.toBe(v);
        expect(label).not.toMatch(/^[a-z_.]+$/);
      }
    });

    it("a cart's chips: the cart's words; a click puts the token in; one not named yet shows its token", () => {
      wrap(
        <Builder
          automation={draftOf(
            { type: 'cart_abandoned', config: {} },
            [
              { id: 't', type: 'automation_trigger', data: {} },
              { id: 'm', type: 'send_message_text', data: { text: 'Hi ' } },
            ],
            [{ id: 'e', source: 't', target: 'm', sourceHandle: null }],
          )}
          catalog={{
            ...catalog(false),
            variables: ['first_name', 'cart_url', 'comment.text', 'new_one'],
          }}
          stats={{}}
          webhook={null}
          choices={{ employees: [], teams: [], members: [], skills: [], templates: [] }}
        />,
      );
      fireEvent.click(screen.getByTestId('node-m'));
      const chips = within(screen.getByTestId('inspector-text').parentElement!)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(chips).toEqual(['First name', 'Cart link', 'Comment text', '{{new_one}}']);
      (screen.getByTestId('inspector-text') as HTMLTextAreaElement).setSelectionRange(3, 3);
      fireEvent.click(screen.getByRole('button', { name: 'Cart link' }));
      expect(screen.getByTestId('inspector-text')).toHaveValue('Hi {{cart_url}}');
    });
  });

  describe('★★ AU4 on dev: the issues are the canvas as it is now', () => {
    const windowIssue = {
      errors: [
        issueSchema.parse({
          severity: 'error',
          code: 'needs_24h_window',
          nodeId: 'm',
          message: 'x',
        }),
      ],
      warnings: [],
    };
    const cart = () =>
      showBuilder(
        draftOf(
          { type: 'cart_abandoned', config: {} },
          [
            { id: 't', type: 'automation_trigger', data: {} },
            { id: 'm', type: 'send_message_text', data: { text: 'Hi' } },
          ],
          [{ id: 'e', source: 't', target: 'm', sourceHandle: null }],
        ),
      );
    const tick = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

    it('★ a check still on its way when the step chose email never lands after the answer for email', async () => {
      vi.useFakeTimers();
      let late: (v: typeof windowIssue) => void = () => {};
      actions.checkGraph
        .mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
        .mockResolvedValue({ errors: [], warnings: [] });
      cart();
      await tick();
      fireEvent.click(screen.getByTestId('node-m'));
      fireEvent.click(screen.getByTestId('inspector-via-email'));
      await tick();
      await act(async () => {
        late(windowIssue);
      });
      vi.useRealTimers();
      expect(actions.checkGraph).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('issue-m')).toBeNull();
      expect(screen.getByTestId('node-m')).not.toHaveAttribute('data-marked');
    });

    it('a check that failed clears the issue it would have replaced', async () => {
      vi.useFakeTimers();
      actions.checkGraph.mockResolvedValueOnce(windowIssue).mockResolvedValue(null);
      cart();
      await tick();
      expect(screen.getByTestId('issue-m')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('node-m'));
      fireEvent.click(screen.getByTestId('inspector-via-email'));
      await tick();
      vi.useRealTimers();
      expect(screen.queryByTestId('issue-m')).toBeNull();
    });
  });
});

describe('★★ a duration in the largest unit it fills whole (dev: "1,440 minutes")', () => {
  const card = (type: string, data: Record<string, unknown>) =>
    wrap(
      <NodeCard
        node={{ id: 'n', type, position: { x: 0, y: 0 }, data }}
        trigger={{ type: 'message_received', config: {} } as never}
        selected={false}
        marked={false}
        onSelect={vi.fn()}
      />,
    );

  it.each([
    ['wait', { durationMs: 24 * 60 * 60_000 }, '1 day'],
    ['wait', { durationMs: 2 * 60 * 60_000 }, '2 hours'],
    ['wait', { durationMs: 90 * 60_000 }, '90 minutes'],
    ['wait_for_reply', { timeoutMs: 30 * 60_000 }, 'Up to 30 minutes'],
    ['wait_for_reply', { timeoutMs: 2 * 24 * 60 * 60_000 }, 'Up to 2 days'],
  ])('%s %o reads "%s"', (type, data, words) => {
    card(type, data);
    expect(screen.getByTestId('node-n')).toHaveTextContent(words);
    expect(screen.getByTestId('node-n')).not.toHaveTextContent(/1,440|minutes.*minutes/);
  });
});
