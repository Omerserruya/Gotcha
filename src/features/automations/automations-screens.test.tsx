import { act, fireEvent, render, screen } from '@testing-library/react';
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
import automationsMessages from '@/i18n/messages/en/automations.json';
import commonMessages from '@/i18n/messages/en/common.json';

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

  it('channel marks wear their channel; library steps carry a mark', () => {
    wrap(<StepSheet catalog={catalog(false)} context="x" onPick={vi.fn()} onClose={vi.fn()} />);
    const tones = [...screen.getByTestId('step-send_buttons').querySelectorAll('[data-tone]')].map(
      (el) => el.getAttribute('data-tone'),
    );
    expect(tones).toEqual(['whatsapp', 'instagram']);
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

  it('cart left behind: its channels, the delay in hours, and who it sends to', () => {
    showBuilder(draftOf({ type: 'cart_abandoned', config: { delayMinutes: 120 } }));
    expect(screen.getByTestId('inspector-channel-WHATSAPP')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-channel-EMAIL')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-channel-WEBCHAT')).toBeNull();
    expect(screen.getByTestId('inspector-cart-delay')).toHaveValue(2);
    expect(screen.getByTestId('inspector-cart-consent')).toHaveTextContent('agreed to marketing');
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
