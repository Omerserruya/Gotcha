import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyOfConfig, webchatSettingsSchema, type WebchatConfig } from '@/api/contracts/webchat';
import channelsMessages from '@/i18n/messages/en/channels.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ saveWebchat: vi.fn() }));
vi.mock('./webchat-actions', () => actions);

import type { WebchatTab } from '@/api/contracts/webchat';

import { brandMark } from '@/lib/brand-mark';

import { SAVE_AFTER_MS, WebchatSettings } from './WebchatSettings';

const config: WebchatConfig = webchatSettingsSchema.parse({
  data: {
    displayName: 'Site',
    appearance: {
      primaryColor: '#C96A4B',
      logoUrl: null,
      language: 'auto',
      showPoweredBy: true,
    },
    ux: {
      welcome: { assistantName: 'Aviv assistant', suggestedQuestions: ['Where is my order?'] },
      launcher: { position: 'right' },
      hero: { mediaType: 'none', mediaUrl: null },
      proactive: { enabled: true, trigger: 'time_on_page', delaySeconds: 5, message: 'Hi' },
    },
  },
}).data;

const show = (tab: WebchatTab, live = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: channelsMessages }}>
      <WebchatSettings
        id="wc1"
        initial={config}
        widget={{ widgetId: 'widget_1', live, name: 'avivco.il' }}
        business="Aviv & Co."
        tab={tab}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  actions.saveWebchat.mockReset();
  actions.saveWebchat.mockImplementation((_id: string, next: WebchatConfig) =>
    Promise.resolve(next),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const pause = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS);
  });

describe('★★ no Save button: a change is saved after a pause, the last one winning', () => {
  it('two quick changes are one save, of the last; the preview shows it at once', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-4F7A2E'));
    fireEvent.click(screen.getByTestId('webchat-position-left'));
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveStyle({
      backgroundColor: '#4F7A2E',
    });
    expect(actions.saveWebchat).not.toHaveBeenCalled();
    await pause();
    expect(actions.saveWebchat).toHaveBeenCalledTimes(1);
    const [id, sent] = actions.saveWebchat.mock.calls[0] as [string, WebchatConfig];
    expect(id).toBe('wc1');
    expect(sent.appearance.primaryColor).toBe('#4F7A2E');
    expect(sent.ux.launcher.position).toBe('left');
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent('Saved');
  });

  it('a failed save says so - never "Saved"', async () => {
    actions.saveWebchat.mockResolvedValue(null);
    show('behaviour');
    fireEvent.click(screen.getByTestId('webchat-powered-switch'));
    await pause();
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent('Not saved');
  });

  it('a half-typed colour is never saved; a whole one is', async () => {
    show('appearance');
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#12' } });
    await pause();
    expect(actions.saveWebchat).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#123456' } });
    await pause();
    expect(actions.saveWebchat.mock.calls[0]?.[1].appearance.primaryColor).toBe('#123456');
  });

  it('an image address is saved only when it is https', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    const field = screen.getByTestId('webchat-cover-url');
    fireEvent.change(field, { target: { value: 'http://x.co/a.png' } });
    fireEvent.blur(field);
    await pause();
    expect(actions.saveWebchat).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'https://x.co/a.png' } });
    fireEvent.blur(field);
    await pause();
    const sent = actions.saveWebchat.mock.calls[0]?.[1] as WebchatConfig;
    expect(bodyOfConfig(sent).ux.hero).toEqual({
      mediaType: 'image',
      mediaUrl: 'https://x.co/a.png',
    });
  });

  it('the opening questions: typed into the preview, saved as three', async () => {
    show('conversation');
    fireEvent.change(screen.getByTestId('webchat-question-1'), {
      target: { value: 'Can I exchange?' },
    });
    expect(screen.getByTestId('webchat-preview-questions')).toHaveTextContent('Can I exchange?');
    await pause();
    const sent = actions.saveWebchat.mock.calls[0]?.[1] as WebchatConfig;
    expect(bodyOfConfig(sent).ux.welcome.suggestedQuestions).toEqual([
      'Where is my order?',
      'Can I exchange?',
    ]);
  });
});

describe('★ what cannot be stored yet is drawn, off, and says why', () => {
  it('the assigned employee: a status, not radios - with the reason', () => {
    show('conversation');
    expect(screen.getByTestId('webchat-employee-why')).toHaveTextContent(
      "Choosing who answers the web chat isn't available here yet",
    );
    expect(screen.getByTestId('webchat-employee-why')).toHaveTextContent('Not available yet');
    expect(screen.getByTestId('webchat-employee-why')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('radio', { name: 'Shira' })).toBeNull();
  });

  it('WhatsApp, products, cart and deals: statuses with a reason each - no switch to press', () => {
    show('behaviour');
    for (const k of ['whatsapp', 'products', 'cart', 'deals']) {
      expect(screen.queryByTestId(`webchat-${k}-switch`)).toBeNull();
      expect(screen.getByTestId(`webchat-${k}-unavailable`)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByTestId(`webchat-${k}`)).toHaveTextContent('Not available yet');
    }
    expect(screen.getByTestId('webchat-powered-switch')).toBeEnabled();
  });

  it('Shopify and WooCommerce: statuses, not buttons, and say to use the line of code', () => {
    show('install');
    expect(screen.getByTestId('webchat-shopify').querySelector('button')).toBeNull();
    expect(screen.getByTestId('webchat-shopify-action')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('webchat-woo-action')).toHaveTextContent('Not available yet');
  });
});

describe('★ install', () => {
  it('the snippet carries THIS widget; Copy copies exactly it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show('install');
    const code = screen.getByTestId('webchat-snippet-code').textContent ?? '';
    expect(code).toContain('widgetId: "widget_1"');
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-copy'));
    });
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it('not live: Go live opens Install, and the strip waits for the first visit', () => {
    show('install');
    expect(screen.getByTestId('webchat-status')).toHaveTextContent('Not live yet');
    expect(screen.getByTestId('webchat-go-live').getAttribute('href')).toContain('"tab":"install"');
    expect(screen.getByTestId('webchat-install-status')).toHaveTextContent(
      'Waiting for the first visit',
    );
  });

  it('live: no Go live, and the chip says Live', () => {
    show('install', true);
    expect(screen.getByTestId('webchat-status')).toHaveTextContent('Live');
    expect(screen.queryByTestId('webchat-go-live')).toBeNull();
  });
});

describe("★ the preview's marks come from one name - the business's", () => {
  it('logo "AVIV & CO.", launcher its first word "AVIV" (dev: "STOR" beside "ST")', () => {
    expect(brandMark('Aviv & Co.')).toEqual({ logo: 'AVIV & CO.', launcher: 'AVIV' });
    // dev: "Urban Supply - GOTCHA..." drew "URBAN SUPPLY -".
    expect(brandMark('Urban Supply - GOTCHA demo store')).toEqual({
      logo: 'URBAN SUPPLY',
      launcher: 'URBAN',
    });
    expect(brandMark('Urban Supply | Shop').logo).toBe('URBAN SUPPLY');
    expect(brandMark('Urban Supply · Tel Aviv').logo).toBe('URBAN SUPPLY');
    expect(brandMark('Shop,').launcher).toBe('SHOP');
    show('appearance');
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveTextContent(/^AVIV$/);
    expect(screen.getByTestId('webchat-preview')).toHaveTextContent('AVIV & CO.');
  });
});
