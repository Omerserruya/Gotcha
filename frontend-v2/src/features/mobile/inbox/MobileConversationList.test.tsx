import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/he/channels.json';
import inbox from '@/i18n/messages/he/inbox.json';
import mobile from '@/i18n/messages/he/mobile.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'he',
      messages: { mobile, inbox, channels },
      namespace: namespace as 'mobile',
    }),
  getFormatter: async () => ({ dateTime: () => '10:00', relativeTime: () => '', number: String }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href: _h, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { MobileConversationList } from './MobileConversationList';

/** The tag under an unheld handoff, as the phone draws it (2026-11-15). */
const handoff = {
  id: 'c1',
  status: 'WAITING' as const,
  channel: 'WHATSAPP',
  handledBy: 'human' as const,
  assignedAgentId: null,
  assignedAiAgentId: null,
  isHandedOver: true,
  lastMessageAt: '2026-11-15T09:00:00Z',
  customerName: 'Dana',
  customerExternalId: '+972541234567',
  contactId: null,
  lastMessageBody: 'Hi',
  lastMessageType: 'text',
  lastMessageDirection: 'INBOUND' as const,
  departmentId: null,
  createdAt: '2026-11-15T08:00:00Z',
};

const show = async (soleHuman?: boolean) =>
  render(
    await MobileConversationList({
      // The row's other fields are the schema's defaults; only the tag is under test.
      rows: [handoff as never],
      now: new Date('2026-11-15T10:00:00Z'),
      meId: 'u1',
      colleagues: [],
      filtered: false,
      soleHuman,
    }),
  );

describe('★ one person: the tag says "waiting for you", not "in queue"', () => {
  it('★★ one person', async () => {
    await show(true);
    expect(screen.getByText(mobile.inbox.owner.waitingYou)).toBeInTheDocument();
    expect(screen.queryByText(mobile.inbox.owner.waiting)).toBeNull();
  });

  it('★ a team', async () => {
    await show();
    expect(screen.getByText(mobile.inbox.owner.waiting)).toBeInTheDocument();
    expect(screen.queryByText(mobile.inbox.owner.waitingYou)).toBeNull();
  });
});

describe('★★ which number on the phone row (Omer, 2026-11-16)', () => {
  const list = async (channelAccount: unknown) =>
    render(
      await MobileConversationList({
        rows: [{ ...handoff, channelAccount } as never],
        now: new Date('2026-11-15T10:00:00Z'),
        meId: 'u1',
        colleagues: [],
        filtered: false,
      }),
    );

  it('★★ two numbers: "וואטסאפ · מכירות", beside the owner tag', async () => {
    await list({ id: 'ch1', channel: 'WHATSAPP', displayName: 'מכירות', multipleOfChannel: true });
    expect(screen.getByTestId('mobile-account-c1')).toHaveTextContent(`${channels.name.WHATSAPP} · מכירות`);
    expect(screen.getByText(mobile.inbox.owner.waiting)).toBeInTheDocument();
  });

  it('★ one number: no tag', async () => {
    await list({ id: 'ch9', channel: 'WHATSAPP', displayName: 'Only', multipleOfChannel: false });
    expect(screen.queryByTestId('mobile-account-c1')).toBeNull();
  });
});
