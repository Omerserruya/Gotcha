import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { ImportPanel, ReportPanel } from '@/features/channels/LearnPanels';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { ChannelLanding } from '@/features/channels/ChannelLanding';
import { ConnectWhatsApp } from '@/features/channels/ConnectWhatsApp';
import { WhatsAppPanel } from '@/features/channels/WhatsAppPanel';
import channels from '@/i18n/messages/en/channels.json';

/*
 * ★★ THE HEAD AND THE CARD READ THE SAME OBJECT.
 * ec2aaf9 said the head counted both lists; it still counted `data` only - a
 * text replacement had matched nothing after formatting, and the claim went
 * into the commit message anyway. Dev's one number is UNPROFILED, so the head
 * read "no numbers yet" over its card. This renders the page with dev's shape.
 */
const DEV_NUMBERS = {
  data: [],
  unprofiled: [
    {
      channelAccountId: 'ca1',
      phoneNumberId: '1010938148762991',
      name: 'Demo WhatsApp',
      connectionStatus: 'CONNECTED',
    },
  ],
};

vi.mock('@/features/channels/load-channels', () => ({
  loadChannels: async () => ({ channels: [], voice: [], voiceOffered: false, windowDays: 30 }),
}));
const { history } = vi.hoisted(() => ({
  history: {
    value: { status: null, candidates: null, bulkMinConfidence: undefined } as Record<
      string,
      unknown
    >,
  },
}));
const reads = vi.hoisted(() => ({ templates: vi.fn(), exclusions: vi.fn(), events: vi.fn() }));
vi.mock('@/features/webchat/load-website-widget', () => ({ loadWidgetInstall: async () => null }));
vi.mock('@/features/outreach/load-templates', () => ({ loadTemplates: reads.templates }));
vi.mock('@/features/channels/load-whatsapp', () => ({
  loadExclusions: reads.exclusions,
  loadNumberEvents: reads.events,
  loadWhatsAppNumbers: async () => DEV_NUMBERS,
  loadHistoryImport: async () => history.value,
  loadChannelsConfig: async () => ({
    launches: { coexistence: null, newNumber: null },
    providers: null,
  }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { channels }, namespace: namespace as 'channels' }),
  getLocale: async () => 'he',
}));
vi.mock('server-only', () => ({}));
const navRedirect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
);
vi.mock('@/i18n/navigation', () => ({ Link: 'a', redirect: navRedirect }));

function find<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, ReactNode>>;
  if (element.type === type) return element.props as P;
  for (const value of Object.values(element.props ?? {})) {
    const hit = find<P>(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

describe('★ the web chat’s old ?embed= link: its code is the widget’s Install tab now', () => {
  it('redirects there, in the locale it came in', async () => {
    const { default: Page } = await import('./page');
    await expect(Page({ searchParams: Promise.resolve({ embed: 'wc1' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(navRedirect).toHaveBeenCalledWith({
      href: { pathname: '/settings/channels/website', query: { tab: 'install' } },
      locale: 'he',
    });
  });
});

describe('★★ 13b - the head counts what the card shows', () => {
  it('dev’s one unprofiled number: "one number", and the card gets that same list', async () => {
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ panel: 'whatsapp' }) });
    const panel = find<{ line: string }>(tree, WhatsAppPanel);
    expect(panel?.line).toBe('WhatsApp Business account · one number');
    expect(find<{ numbers: unknown }>(tree, WhatsAppNumbers)?.numbers).toBe(DEV_NUMBERS);
  });
});

describe('★ 13e / 13f are their own panels, replacing 13b while open', () => {
  const STATUS = { id: 'i1', stage: 'analyzing', percent: 100, analysisPercent: 40 };

  it('★ ?view=connect opens 13c’s sheet over Channels, with the server’s launch; not 13b', async () => {
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ panel: 'whatsapp', view: 'connect' }),
    });
    const sheet = find<{ launch: unknown; closeHref: string }>(tree, ConnectWhatsApp);
    expect(sheet).not.toBeNull();
    expect(sheet?.closeHref).toBe('/settings/channels?panel=whatsapp');
    expect(find(tree, WhatsAppPanel)).toBeNull();
  });

  it('★ the way back from a provider: said over the list', async () => {
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ platform: 'messenger', error: 'no_pages' }),
    });
    expect(find<{ landing: unknown }>(tree, ChannelLanding)?.landing).toEqual({
      channel: 'MESSENGER',
      outcome: 'no_pages',
    });
  });

  it('?view=progress opens 13e and not 13b', async () => {
    history.value = { status: STATUS, candidates: [], bulkMinConfidence: 0.8 };
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ panel: 'whatsapp', import: 'i1', view: 'progress' }),
    });
    expect(find(tree, ImportPanel)).not.toBeNull();
    expect(find(tree, WhatsAppPanel)).toBeNull();
  });

  it('?view=report opens 13f with the candidates', async () => {
    history.value = {
      status: { ...STATUS, stage: 'ready' },
      candidates: [],
      bulkMinConfidence: 0.8,
    };
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ panel: 'whatsapp', import: 'i1', view: 'report' }),
    });
    expect(find(tree, ReportPanel)).not.toBeNull();
  });

  it('a view with no import falls back to 13b', async () => {
    history.value = { status: null, candidates: null, bulkMinConfidence: undefined };
    const { default: Page } = await import('./page');
    const tree = await Page({
      searchParams: Promise.resolve({ panel: 'whatsapp', view: 'progress' }),
    });
    expect(find(tree, ImportPanel)).toBeNull();
    expect(find(tree, WhatsAppPanel)).not.toBeNull();
  });
});

describe('★★ 13b · ?tab= decides what is read and shown', () => {
  const open = async (tab?: string) => {
    for (const fn of Object.values(reads)) fn.mockReset();
    reads.templates.mockResolvedValue({ templates: [], total: 0 });
    reads.exclusions.mockResolvedValue([]);
    reads.events.mockResolvedValue([]);
    const { default: Page } = await import('./page');
    return Page({ searchParams: Promise.resolve({ panel: 'whatsapp', ...(tab ? { tab } : {}) }) });
  };

  it('Numbers by default: the numbers, and none of the other reads', async () => {
    const tree = await open();
    expect(find<{ tab: string }>(tree, WhatsAppPanel)?.tab).toBe('numbers');
    expect(find(tree, WhatsAppNumbers)).not.toBeNull();
    expect(reads.templates).not.toHaveBeenCalled();
    expect(reads.exclusions).not.toHaveBeenCalled();
    expect(reads.events).not.toHaveBeenCalled();
  });

  it.each([
    ['templates', 'templates'],
    ['contacts', 'exclusions'],
    ['activity', 'events'],
  ] as const)('?tab=%s reads only its own', async (tab, read) => {
    const tree = await open(tab);
    expect(find<{ tab: string }>(tree, WhatsAppPanel)?.tab).toBe(tab);
    expect(find(tree, WhatsAppNumbers)).toBeNull();
    for (const [name, fn] of Object.entries(reads)) {
      expect(fn, name).toHaveBeenCalledTimes(name === read ? 1 : 0);
    }
  });

  it('an unknown tab is Numbers', async () => {
    const tree = await open('nonsense');
    expect(find<{ tab: string }>(tree, WhatsAppPanel)?.tab).toBe('numbers');
  });
});
