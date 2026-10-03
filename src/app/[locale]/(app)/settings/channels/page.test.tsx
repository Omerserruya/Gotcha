import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { ImportPanel, ReportPanel } from '@/features/channels/LearnPanels';
import { WhatsAppNumbers } from '@/features/channels/WhatsAppNumbers';
import { WhatsAppPanel } from '@/features/channels/WhatsAppPanel';
import channels from '@/i18n/messages/en/channels.json';

/*
 * ★★ THE HEAD AND THE CARD READ THE SAME OBJECT.
 * ec2aaf9 said the head counted both lists; it still counted `data` only — a
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
vi.mock('@/features/channels/load-whatsapp', () => ({
  loadWhatsAppNumbers: async () => DEV_NUMBERS,
  loadHistoryImport: async () => history.value,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { channels }, namespace: namespace as 'channels' }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

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

describe('★★ 13b — the head counts what the card shows', () => {
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
