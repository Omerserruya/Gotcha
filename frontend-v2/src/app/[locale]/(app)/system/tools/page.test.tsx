import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** /system/tools: behind the door; a failed read is never an empty queue. */
const { door, load } = vi.hoisted(() => ({
  door: { open: true },
  load: { loadPendingServers: vi.fn() },
}));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/features/agent-tools/load-agent-tools', () => load);
vi.mock('@/features/agent-tools/McpQueue', () => ({
  McpQueue: ({ servers, sentAt }: { servers: { id: string }[]; sentAt: Record<string, string> }) => (
    <div data-testid="queue" data-count={servers.length} data-sent={JSON.stringify(sentAt)} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.toolsQueue') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
  getFormatter: async () => ({ dateTime: () => '16 Nov 2026, 10:12' }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

const { default: Page } = await import('./page');
const { pending } = await import('@/features/agent-tools/fixtures');

const open = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page()}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  door.open = true;
  load.loadPendingServers.mockReset();
});

describe('★★ /system/tools', () => {
  it('★ behind the console door: nothing is read without it', async () => {
    door.open = false;
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(load.loadPendingServers).not.toHaveBeenCalled();
  });

  it('the queue, each send time formatted here on the server', async () => {
    load.loadPendingServers.mockResolvedValue([pending(), pending({ id: 'srv_2', submittedAt: null })]);
    await open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(consoleEn.toolsQueue.title);
    const queue = screen.getByTestId('queue');
    expect(queue).toHaveAttribute('data-count', '2');
    expect(JSON.parse(queue.getAttribute('data-sent')!)).toEqual({ srv_1: '16 Nov 2026, 10:12' });
  });

  it('★ a failed read says so, never "nothing is waiting"', async () => {
    load.loadPendingServers.mockResolvedValue(null);
    await open();
    expect(screen.getByTestId('queue-unread')).toHaveTextContent(consoleEn.toolsQueue.unread);
    expect(screen.queryByTestId('queue')).toBeNull();
  });
});
