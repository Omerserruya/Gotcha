import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** /system/whatsapp: behind the door; each failed read said in its own place. */
const { door, load } = vi.hoisted(() => ({
  door: { open: true },
  load: { loadPlatformSender: vi.fn(), loadPlatformTemplates: vi.fn() },
}));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/features/console/platform-whatsapp/load-platform-whatsapp', () => load);
vi.mock('@/features/console/platform-whatsapp/PlatformNumber', () => ({
  PlatformNumber: ({ sender }: { sender: { status: string } }) => (
    <div data-testid="number" data-status={sender.status} />
  ),
}));
vi.mock('@/features/console/platform-whatsapp/PlatformTemplates', () => ({
  PlatformTemplates: ({ canSubmit }: { canSubmit: boolean }) => (
    <div data-testid="templates" data-can-submit={String(canSubmit)} />
  ),
}));
vi.mock('@/features/console/platform-whatsapp/PlatformAlerts', () => ({
  PlatformAlerts: ({ canSend, hasNumber }: { canSend: boolean; hasNumber: boolean }) => (
    <div data-testid="alerts" data-can-send={String(canSend)} data-has-number={String(hasNumber)} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.platformWhatsApp') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
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

const open = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page()}
    </NextIntlClientProvider>,
  );

const w = consoleEn.platformWhatsApp;
const number = { display: '+972', phoneNumberId: 'pn' };

beforeEach(() => {
  door.open = true;
  load.loadPlatformSender.mockReset();
  load.loadPlatformTemplates.mockReset();
  load.loadPlatformSender.mockResolvedValue({ status: 'CONNECTED', number });
  load.loadPlatformTemplates.mockResolvedValue([]);
});

describe('★★ /system/whatsapp', () => {
  it('★★ not a system admin: not found, and nothing is read', async () => {
    door.open = false;
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(load.loadPlatformSender).not.toHaveBeenCalled();
    expect(load.loadPlatformTemplates).not.toHaveBeenCalled();
  });

  it('★★ the three parts, under the page’s own title', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(w.title);
    expect(screen.getByTestId('number')).toBeInTheDocument();
    expect(screen.getByTestId('templates')).toHaveAttribute('data-can-submit', 'true');
    expect(screen.getByTestId('alerts')).toHaveAttribute('data-can-send', 'true');
  });

  it('★★ a failed status read is said, never drawn as "not connected"', async () => {
    load.loadPlatformSender.mockResolvedValue(undefined);
    await open();
    expect(screen.getByTestId('platform-unread')).toHaveTextContent(w.unread);
    expect(screen.queryByTestId('number')).toBeNull();
    expect(screen.getByTestId('alerts')).toHaveAttribute('data-can-send', 'false');
  });

  it('★★ a failed templates read is said; the number still shows', async () => {
    load.loadPlatformTemplates.mockResolvedValue(undefined);
    await open();
    expect(screen.getByTestId('platform-templates-unread')).toHaveTextContent(w.templates.unread);
    expect(screen.getByTestId('number')).toBeInTheDocument();
    expect(screen.queryByTestId('alerts')).toBeNull();
  });

  it('★ token expired: a number, but nothing sends', async () => {
    load.loadPlatformSender.mockResolvedValue({ status: 'TOKEN_INVALID', number });
    await open();
    expect(screen.getByTestId('alerts')).toHaveAttribute('data-can-send', 'false');
    expect(screen.getByTestId('alerts')).toHaveAttribute('data-has-number', 'true');
  });

  it('★ disconnected: no number for templates or switches', async () => {
    load.loadPlatformSender.mockResolvedValue({ status: 'DISCONNECTED', number });
    await open();
    expect(screen.getByTestId('templates')).toHaveAttribute('data-can-submit', 'false');
    expect(screen.getByTestId('alerts')).toHaveAttribute('data-has-number', 'false');
  });
});
