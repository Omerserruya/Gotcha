import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { WhatsAppPanel } from './WhatsAppPanel';

describe('★ 13b is a panel over Channels', () => {
  it('its head, its way back, and its tabs - Numbers live, the rest drawn', async () => {
    render(await WhatsAppPanel({ line: 'One number', children: <p>numbers here</p> }));
    const panel = screen.getByTestId('whatsapp-panel');
    expect(panel).toHaveTextContent('WhatsApp');
    expect(panel).toHaveTextContent('One number');
    expect(screen.getByTestId('whatsapp-close')).toHaveAttribute('href', '/settings/channels');
    expect(screen.getByText('Numbers')).toHaveAttribute('aria-current', 'page');
    for (const tab of ['Templates', 'Private contacts', 'Activity']) {
      expect(screen.getByText(tab)).toHaveAttribute('aria-disabled', 'true');
    }
    expect(panel).toHaveTextContent('numbers here');
  });

  it('★ measured on dev: the foot says its three things in words - not two bare icons', async () => {
    // 13f's actions once replaced `whatsapp.foot` whole and took these labels with them.
    render(await WhatsAppPanel({ line: 'One number', children: <p>numbers here</p> }));
    const panel = screen.getByTestId('whatsapp-panel');
    for (const words of ['Refresh from Meta', 'Activity log', 'Disconnect this number']) {
      expect(panel).toHaveTextContent(words);
    }
  });
});
