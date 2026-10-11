import { act, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import heCommon from '@/i18n/messages/he/common.json';
import heInbox from '@/i18n/messages/he/inbox.json';
import { DEVICE_ALERTS_KEY } from '@/lib/inbound-alerts/settings';
import type { RealtimeEvent } from '@/realtime/events';

/**
 * The listener as mounted: the socket's event in, the browser's Notification
 * out - with the words, the read and the quiet hours wired, which the unit
 * tests of each piece cannot see.
 */
const heard = vi.hoisted(() => ({ listener: null as ((event: RealtimeEvent) => void) | null }));
vi.mock('@/realtime/realtime-provider', () => ({
  useRealtimeEvent: (_type: string, listener: (event: RealtimeEvent) => void) => {
    heard.listener = listener;
  },
}));

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/browser-api', () => ({ browserApi: { get } }));

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

/* A background tab that leads: the role is the election's test, not this one's. */
vi.mock('@/lib/inbound-alerts/election', () => ({
  AlertElection: class {
    start() {}
    stop() {}
    role() {
      return 'leader';
    }
  },
}));
const play = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/inbound-alerts/chime', () => ({
  sharedChime: () => ({ prime: () => {}, play }),
}));
vi.mock('./notification-icon', () => ({
  channelIconUrl: async (channel: string | null) => `icon:${channel}`,
}));

import { InboundAlerts } from './InboundAlerts';

const made: { title: string; options: NotificationOptions; onclick?: (e: Event) => void }[] = [];
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn();
  onclick: ((e: Event) => void) | null = null;
  constructor(title: string, options: NotificationOptions) {
    made.push(Object.assign(this, { title, options }) as never);
  }
  close() {}
}

/** The reads, by path. */
function platform(reads: {
  quietHours?: { from: string; to: string } | null;
  workspace?: unknown;
  conversation?: unknown;
}) {
  get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    if (endpoint.path === '/api/notification-preferences/me') {
      return {
        inApp: true,
        email: true,
        whatsapp: false,
        approvals: true,
        quietHours: reads.quietHours ?? null,
      };
    }
    if (endpoint.path === '/api/workspace') {
      if (reads.workspace === undefined) throw new ApiError({ kind: 'authorization', status: 403 });
      return reads.workspace;
    }
    if (endpoint.path.startsWith('/api/conversations/')) {
      if (reads.conversation instanceof Error) throw reads.conversation;
      return reads.conversation;
    }
    throw new Error(`unexpected read ${endpoint.path}`);
  });
}

const inbound = (over: Record<string, unknown> = {}) =>
  ({
    type: 'message.received',
    tenantId: 't1',
    at: 0,
    conversationId: 'c1',
    messageId: `m-${Math.random()}`,
    direction: 'INBOUND',
    body: '[Image]',
    messageType: 'image',
    ...over,
  }) as RealtimeEvent;

async function mount() {
  render(
    <NextIntlClientProvider
      locale="he"
      timeZone="Asia/Jerusalem"
      messages={{ inbox: heInbox, common: heCommon }}
    >
      <InboundAlerts tenantId="t1" />
    </NextIntlClientProvider>,
  );
  // The quiet-hours reads settle.
  await act(async () => {});
}

async function arrive(event: RealtimeEvent) {
  await act(async () => {
    heard.listener!(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  made.length = 0;
  heard.listener = null;
  get.mockReset();
  push.mockReset();
  play.mockClear();
  window.localStorage.setItem(DEVICE_ALERTS_KEY, '{"sound":true,"desktop":true}');
  vi.stubGlobal('Notification', FakeNotification);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T09:00:00Z')); // 12:00 in Jerusalem
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('★ InboundAlerts, mounted', () => {
  it('★ a customer’s photo: a chime, and a notification with the name, the kind in Hebrew, the channel icon', async () => {
    platform({
      conversation: { customerName: 'דנה לוי', customerExternalId: null, channel: 'WHATSAPP' },
    });
    await mount();
    await arrive(inbound());
    expect(play).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe('דנה לוי');
    expect(made[0]!.options).toMatchObject({
      body: 'תמונה',
      icon: 'icon:WHATSAPP',
      tag: 'conv:c1',
      lang: 'he',
    });
    // The click: this tab forward, that conversation open.
    made[0]!.onclick!(new Event('click', { cancelable: true }));
    expect(push).toHaveBeenCalledWith('/inbox?c=c1');
  });

  it('★ a conversation the read refuses (404): nothing at all', async () => {
    platform({ conversation: new ApiError({ kind: 'not_found', status: 404 }) });
    await mount();
    await arrive(inbound());
    expect(play).not.toHaveBeenCalled();
    expect(made).toHaveLength(0);
  });

  it('★ inside quiet hours, in the workspace’s zone: nothing', async () => {
    platform({
      // 22:00-07:00, and 09:00 UTC is 05:00 in New York: inside.
      quietHours: { from: '22:00', to: '07:00' },
      workspace: { timezone: 'America/New_York', hours: { schedule: {} } },
      conversation: { customerName: 'Dana', customerExternalId: null, channel: 'WHATSAPP' },
    });
    await mount();
    await arrive(inbound());
    expect(made).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it('the same window, read in Jerusalem (12:00): alerts', async () => {
    platform({
      quietHours: { from: '22:00', to: '07:00' },
      workspace: { timezone: 'Asia/Jerusalem', hours: { schedule: {} } },
      conversation: { customerName: 'Dana', customerExternalId: null, channel: 'WHATSAPP' },
    });
    await mount();
    await arrive(inbound());
    expect(made).toHaveLength(1);
  });

  it('a system row the platform wrote: nothing, and nothing read', async () => {
    platform({
      conversation: { customerName: 'Dana', customerExternalId: null, channel: 'WHATSAPP' },
    });
    await mount();
    await arrive(inbound({ messageType: 'system', body: '' }));
    expect(made).toHaveLength(0);
    expect(
      get.mock.calls.some(([r]) => String(r.endpoint.path).startsWith('/api/conversations/')),
    ).toBe(false);
  });

  it('no name and no handle: "someone" in the reader’s words, and the first line', async () => {
    platform({ conversation: { customerName: null, customerExternalId: null, channel: null } });
    await mount();
    await arrive(inbound({ body: 'שלום\nעוד שורה', messageType: 'text' }));
    expect(made[0]!.title).toBe(heInbox.queue.unnamed);
    expect(made[0]!.options.body).toBe('שלום');
  });
});
