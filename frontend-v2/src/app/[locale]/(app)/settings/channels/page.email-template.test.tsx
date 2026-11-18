import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import { EmailTemplateEditor } from '@/features/channels/EmailTemplateEditor';
import { RelevanceFilterSwitch } from '@/features/channels/RelevanceFilterSwitch';
import channels from '@/i18n/messages/en/channels.json';
import { Drawer } from '@/shell/Drawer';

/**
 * `?panel=email&id=`: a mailbox's template, over Channels. Opened only for an
 * EMAIL account on this workspace's list; the reads are spies.
 */
const ACCOUNTS = [
  channelSchema.parse({
    id: 'g1',
    channel: 'GMAIL',
    displayName: 'shop@halvo-dev.test',
    relevanceFilterEnabled: false,
  }),
  channelSchema.parse({ id: 'm1', channel: 'MESSENGER', displayName: 'Halvo' }),
  // A second mailbox the backend says nothing about (an older backend).
  channelSchema.parse({ id: 'g2', channel: 'GMAIL', displayName: 'b@halvo-dev.test' }),
];
const STORED = { enabled: false, html: '<p>{{content}}</p>', updatedAt: null };

const reads = vi.hoisted(() => ({
  template: vi.fn(),
  names: vi.fn(async () => ({ agent: 'Maya Levi', business: 'Halvo' })),
}));
vi.mock('@/features/channels/load-email-template', () => ({
  loadEmailTemplate: reads.template,
  loadPreviewNames: reads.names,
}));
vi.mock('@/features/channels/load-channels', () => ({
  loadChannels: async () => ({
    channels: ACCOUNTS,
    voice: [],
    voiceOffered: false,
    windowDays: 30,
  }),
}));
vi.mock('@/features/channels/messenger-actions', () => ({ loadMessengerPages: vi.fn() }));
vi.mock('@/features/webchat/load-website-widget', () => ({ loadWidgetInstall: async () => null }));
vi.mock('@/features/channels/load-whatsapp', () => ({
  loadChannelsConfig: async () => ({
    launches: { coexistence: null, newNumber: null },
    providers: null,
  }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: { channels }, namespace: namespace as 'channels' }),
  getLocale: async () => 'en',
}));
vi.mock('server-only', () => ({}));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock('@/api/client/inbox-relevance', () => ({ inboxRelevanceOn: () => flag.on }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a', redirect: vi.fn() }));

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

const open = async (params: Record<string, string>) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(params) });
};

beforeEach(() => {
  flag.on = true;
  reads.template.mockReset();
  reads.template.mockResolvedValue({ state: 'ok', template: STORED });
  reads.names.mockClear();
});

describe('★ a mailbox’s template drawer', () => {
  it('opens for that mailbox: its address on the head, its stored template in the editor', async () => {
    const tree = await open({ panel: 'email', id: 'g1' });
    const drawer = find<{ title: string; line: string; userLine: boolean; testId: string }>(
      tree,
      Drawer,
    );
    expect(drawer).toMatchObject({
      title: 'Email template',
      line: 'shop@halvo-dev.test',
      // An address: through UserText, so an edge rewriting emails cannot reach it.
      userLine: true,
      testId: 'drawer-email-template',
    });
    expect(reads.template).toHaveBeenCalledWith('g1');
    expect(find(tree, EmailTemplateEditor)).toMatchObject({
      channelId: 'g1',
      stored: STORED,
      names: { agent: 'Maya Levi', business: 'Halvo' },
    });
  });

  it.each([
    ['an account that is not email', { panel: 'email', id: 'm1' }],
    ['an id not on this list', { panel: 'email', id: 'nope' }],
    ['no id', { panel: 'email' }],
  ])('opens nothing, and reads nothing, for %s', async (_, params) => {
    const tree = await open(params);
    expect(find(tree, Drawer)).toBeNull();
    expect(reads.template).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'The template could not be read'],
    ['forbidden', 'You do not have permission to see'],
  ] as const)('a %s read says so, and offers no editor to overwrite with', async (state, words) => {
    reads.template.mockResolvedValueOnce({ state });
    const tree = await open({ panel: 'email', id: 'g1' });
    expect(find(tree, EmailTemplateEditor)).toBeNull();
    const said = find<{ children: string; role: string }>(tree, 'p');
    expect(said?.role).toBe('alert');
    expect(said?.children).toContain(words);
  });
});

describe('★★ the mailbox’s relevance filter, above its template', () => {
  it('this mailbox’s switch, with its stored value, in a part of its own above the template', async () => {
    const tree = await open({ panel: 'email', id: 'g1' });
    expect(find(tree, RelevanceFilterSwitch)).toEqual({ channelAccountId: 'g1', enabled: false });
    const body = find<{ children: ReactNode[] }>(tree, 'div');
    const parts = (body?.children ?? []).filter(isValidElement) as ReactElement<
      Record<string, unknown>
    >[];
    expect(parts.map((part) => part.props['data-testid'])).toEqual([
      'mailbox-filter-part',
      'mailbox-template-part',
    ]);
    const [filterPart, templatePart] = parts;
    expect(find(filterPart, RelevanceFilterSwitch)).not.toBeNull();
    expect(find(filterPart, EmailTemplateEditor)).toBeNull();
    expect(find(templatePart, EmailTemplateEditor)).toMatchObject({ channelId: 'g1' });
    // Each part named: "Filtering", then "Email template".
    expect(find<{ children: string }>(filterPart, 'h3')?.children).toBe(
      channels.relevanceFilter.sectionFilter,
    );
    expect(find<{ children: string }>(templatePart, 'h3')?.children).toBe(
      channels.relevanceFilter.sectionTemplate,
    );
  });

  it('a mailbox with no value from the backend: no switch, the template as before', async () => {
    const tree = await open({ panel: 'email', id: 'g2' });
    expect(find(tree, RelevanceFilterSwitch)).toBeNull();
    // No lone "Email template" heading under a drawer already titled so.
    expect(find(tree, 'h3')).toBeNull();
    expect(find(tree, EmailTemplateEditor)).toMatchObject({ channelId: 'g2' });
  });

  it('★★ INBOX_RELEVANCE off: no switch', async () => {
    flag.on = false;
    const tree = await open({ panel: 'email', id: 'g1' });
    expect(find(tree, RelevanceFilterSwitch)).toBeNull();
    expect(find(tree, EmailTemplateEditor)).toMatchObject({ channelId: 'g1' });
  });
});
