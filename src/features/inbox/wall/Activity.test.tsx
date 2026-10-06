import type React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_LABELS, type ActivityStep } from '@/api/contracts/ai-activity';
import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';
import type { RealtimeEvent, RealtimeEventType } from '@/realtime/events';
import { translate } from '@/realtime/events';

import { ActivityProvider, ActivityStrip, STEPS_SHOWN, WorkingState } from './Activity';

const read = vi.hoisted(() => vi.fn<(id: string) => Promise<readonly ActivityStep[] | null>>());
vi.mock('./wall-actions', () => ({ readActivity: read }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const stop = vi.hoisted(() => vi.fn());
vi.mock('../conversation-actions', () => ({ stopAi: stop }));

const listeners = vi.hoisted(() => new Map<string, ((event: RealtimeEvent) => void)[]>());
const joined = vi.hoisted(() => vi.fn());
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (type: RealtimeEventType, listener: (event: RealtimeEvent) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []).filter((l) => l !== listener), listener]);
  },
  useConversationRoom: joined,
}));
const deliver = (over: Partial<Extract<RealtimeEvent, { type: 'ai.activity.updated' }>>) =>
  act(() =>
    listeners.get('ai.activity.updated')?.at(-1)?.({
      type: 'ai.activity.updated',
      tenantId: 't1',
      at: 0,
      conversationId: 'c1',
      stepId: 'e1',
      tool: 'shopify.order_lookup',
      labelKey: 'looking_up_order',
      status: 'running',
      ts: '2026-10-06T10:00:00.000Z',
      ...over,
    }),
  );

const step = (id: string, over: Partial<ActivityStep> = {}): ActivityStep => ({
  id,
  tool: 'integration_order_lookup',
  labelKey: 'looking_up_order',
  status: 'completed',
  proposedAt: '2026-10-06T09:00:00.000Z',
  startedAt: '2026-10-06T09:00:00.000Z',
  completedAt: '2026-10-06T09:00:00.028Z',
  durationMs: 28,
  error: null,
  ...over,
});

const show = (aiDriving = true) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox: en }}>
      <ActivityProvider conversationId="c1">
        <WorkingState conversationId="c1" aiDriving={aiDriving} />
        <ActivityStrip />
      </ActivityProvider>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  read.mockReset();
  stop.mockReset();
  joined.mockClear();
  listeners.clear();
});

describe('★★ What it did — one read, then the events', () => {
  it('★ dev’s real pair: a lookup done in 28ms, a refund waiting for approval', async () => {
    read.mockResolvedValue([
      step('e2', {
        labelKey: 'processing_refund',
        status: 'proposed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
      }),
      step('e1'),
    ]);
    show();
    expect(await screen.findByTestId('wall-step-e2')).toHaveTextContent(
      'Refundwaiting for approval',
    );
    expect(screen.getByTestId('wall-step-e1')).toHaveTextContent('Order lookup28ms');
    // Somebody must decide it: the words are the way to Approvals.
    expect(screen.getByTestId('wall-step-approve-e2')).toHaveAttribute('href', '/approvals');
    expect(screen.queryByTestId('wall-step-approve-e1')).toBeNull();
    expect(screen.getByTestId('wall-activity-count')).toHaveTextContent('2 steps · 28ms');
    expect(read).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenCalledWith('c1');
    // Nothing running: the header says nothing is, and offers no stop.
    expect(screen.getByTestId('wall-working')).toHaveAttribute('data-working', 'no');
  });

  it('★★ running → completed updates the row in place; nothing re-reads', async () => {
    read.mockResolvedValue([]);
    show();
    await waitFor(() =>
      expect(screen.getByTestId('wall-activity-count')).toHaveTextContent('Nothing yet'),
    );

    deliver({ status: 'running', ts: '2026-10-06T10:00:00.000Z' });
    expect(screen.getByTestId('wall-step-e1')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('wall-working')).toHaveTextContent('Working on this · stop');

    deliver({ status: 'completed', ts: '2026-10-06T10:00:01.500Z' });
    expect(screen.getAllByTestId(/^wall-step-/)).toHaveLength(1);
    expect(screen.getByTestId('wall-step-e1')).toHaveTextContent('Order lookup1.5s');
    expect(screen.getByTestId('wall-working')).toHaveAttribute('data-working', 'no');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('another conversation’s step is not ours', async () => {
    read.mockResolvedValue([]);
    show();
    await waitFor(() => expect(read).toHaveBeenCalled());
    deliver({ conversationId: 'other' });
    expect(screen.queryByTestId('wall-step-e1')).toBeNull();
  });

  it('★ unread is "—" with why, not "Nothing yet"', async () => {
    read.mockResolvedValue(null);
    show();
    await waitFor(() =>
      expect(screen.getByTestId('wall-activity-count')).toHaveAttribute(
        'title',
        expect.stringContaining('Couldn’t read'),
      ),
    );
    expect(screen.getByTestId('wall-activity-count')).toHaveTextContent('—');
  });

  it(`lists ${STEPS_SHOWN}, counts them all; an unknown label is "A step", a failure carries its message`, async () => {
    read.mockResolvedValue([
      step('x', { labelKey: 'something_new', status: 'failed', error: 'Store timed out' }),
      ...Array.from({ length: 6 }, (_, i) => step(`s${i}`)),
    ]);
    show();
    const failed = await screen.findByTestId('wall-step-x');
    expect(failed).toHaveTextContent('A stepfailed');
    expect(failed.querySelector('[title]')).toHaveAttribute('title', 'Store timed out');
    expect(screen.getAllByTestId(/^wall-step-/)).toHaveLength(STEPS_SHOWN);
    expect(screen.getByTestId('wall-activity-count')).toHaveTextContent('7 steps');
  });
});

describe('★★ "stop" is Stop AI — only while it works, only where the AI answers', () => {
  it('presses the same action as the bar’s Stop AI', async () => {
    read.mockResolvedValue([
      step('e1', { status: 'running', completedAt: null, durationMs: null }),
    ]);
    stop.mockResolvedValue({ ok: true });
    show(true);
    fireEvent.click(await screen.findByTestId('wall-stop'));
    await waitFor(() => expect(stop).toHaveBeenCalledWith('c1'));
  });

  it('a person has it: "Working on this", no stop', async () => {
    read.mockResolvedValue([
      step('e1', { status: 'running', completedAt: null, durationMs: null }),
    ]);
    show(false);
    expect(await screen.findByTestId('wall-working')).toHaveTextContent('Working on this');
    expect(screen.queryByTestId('wall-stop')).toBeNull();
  });
});

describe('★ every label Backend can send has words, in both languages', () => {
  it.each(ACTIVITY_LABELS)('%s', (key) => {
    expect(en.wall.activity.label[key]).toBeTruthy();
    expect(he.wall.activity.label[key]).toBeTruthy();
  });
});

describe('★★ ai.activity.updated — the frame the orchestrator emits', () => {
  it('translates `data` with its id, label and status', () => {
    expect(
      translate('ai.activity.updated', {
        conversationId: 'c1',
        id: 'e1',
        tool: 'shopify.process_refund',
        labelKey: 'processing_refund',
        status: 'proposed',
        channel: 'conv:c1',
        ts: '2026-10-06T10:00:00Z',
        tenantId: 't1',
      }),
    ).toMatchObject({
      type: 'ai.activity.updated',
      conversationId: 'c1',
      stepId: 'e1',
      labelKey: 'processing_refund',
      status: 'proposed',
    });
  });

  it('an unknown status is null — one quiet step, not a dropped event', () => {
    expect(
      translate('ai.activity.updated', {
        tenantId: 't1',
        conversationId: 'c1',
        id: 'e1',
        status: 'paused',
      }),
    ).toMatchObject({ status: null });
  });

  it('nothing without the step’s id', () => {
    expect(translate('ai.activity.updated', { tenantId: 't1', conversationId: 'c1' })).toBeNull();
  });
});
