import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { webchatConfigSchema } from '@/api/contracts/webchat';
import channelsMessages from '@/i18n/messages/en/channels.json';

/* The manifest is the gateway's; mocked, so nothing is fetched. */
const bundle = vi.hoisted(() => ({ readWidgetBundle: vi.fn(), WIDGET_BASE: '/widget' }));
vi.mock('@/api/client/widget-bundle', () => bundle);

import { previewWidget, WidgetFrame } from './WidgetFrame';

const config = webchatConfigSchema.parse({
  displayName: '',
  appearance: { primaryColor: '#123456', logoUrl: null, language: 'auto', showPoweredBy: false },
  ux: {
    welcome: {
      title: 'Hi there',
      assistantName: 'Maya',
      suggestedQuestions: ['Where is it?', ' '],
    },
    launcher: { position: 'left' },
    hero: { mediaType: 'none', mediaUrl: null },
    proactive: { enabled: true, trigger: 'time_on_page', delaySeconds: 10, message: 'Need help?' },
  },
  commerce: {
    productMessagingEnabled: false,
    addToCartEnabled: true,
    promotions: { couponIds: [] },
  },
});
const opts = {
  language: 'he' as const,
  employeeName: 'Noa',
  handoff: false,
  business: 'Aviv & Co.',
};

describe('★★ the draft as the real widget is booted with it (the bootstrap’s projection)', () => {
  it('the typed name by default; the employee’s when the header takes it and one is known', () => {
    expect(previewWidget(config, opts).welcome.assistantName).toBe('Maya');
    const employee = { ...config, nameSource: 'employee' as const };
    const booted = previewWidget(employee, opts);
    expect(booted.welcome.assistantName).toBe('Noa');
    expect(booted.ux.welcome.assistantName).toBe('Noa');
    expect(booted.nameSource).toBe('employee');
    // None known: the typed name stays, as the bootstrap does.
    const none = previewWidget(employee, { ...opts, employeeName: null });
    expect(none.welcome.assistantName).toBe('Maya');
    expect(none.nameSource).toBe('custom');
  });

  it('the preview’s language, auto direction, powered-by always on, empty questions dropped', () => {
    const booted = previewWidget(config, opts);
    expect(booted.appearance).toMatchObject({
      language: 'he',
      direction: 'auto',
      showPoweredBy: true,
      primaryColor: '#123456',
      launcherPosition: 'left',
    });
    expect(booted.welcome.suggestedQuestions).toEqual(['Where is it?']);
    expect(booted.welcome.headline).toBe('Hi there');
  });

  it('no product cards, no cart; the WhatsApp button only when it would show', () => {
    expect(previewWidget(config, opts).features).toMatchObject({
      productMessaging: false,
      addToCart: false,
      whatsappHandoff: false,
    });
    const selling = {
      ...config,
      commerce: { ...config.commerce, productMessagingEnabled: true },
    };
    expect(previewWidget(selling, { ...opts, handoff: true }).features).toMatchObject({
      productMessaging: true,
      addToCart: true,
      whatsappHandoff: true,
    });
  });

  it('the brand is the business, with its initial; none without one', () => {
    expect(previewWidget(config, opts).brand).toEqual({ name: 'Aviv & Co.', initial: 'A' });
    expect(previewWidget(config, { ...opts, business: '  ' }).brand).toBeNull();
  });

  it('no identifiers and no live state travel: offline off, no promotions', () => {
    const booted = previewWidget(config, opts);
    expect(booted.offline.active).toBe(false);
    expect(booted.promotions).toEqual([]);
    expect(JSON.stringify(booted)).not.toMatch(/tenant|channelAccount|widgetId/i);
  });
});

const frame = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: channelsMessages }}>
      <WidgetFrame
        config={config}
        employeeName={null}
        handoff={false}
        language="en"
        business={null}
      />
    </NextIntlClientProvider>,
  );

describe('★ the frame', () => {
  beforeEach(() => {
    bundle.readWidgetBundle.mockReset();
  });

  it('a sandboxed window, loading until the bundle is named', async () => {
    let name: (value: string | null) => void = () => {};
    bundle.readWidgetBundle.mockReturnValue(new Promise((resolve) => (name = resolve)));
    frame();
    expect(screen.getByTestId('webchat-preview-loading')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-preview-frame')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin',
    );
    name('gotcha-shopify-chat.abcdef123456.js');
    await waitFor(() => expect(screen.queryByTestId('webchat-preview-loading')).toBeNull());
  });

  it('no bundle: says so, and draws no stand-in', async () => {
    bundle.readWidgetBundle.mockResolvedValue(null);
    frame();
    expect(await screen.findByTestId('webchat-preview-failed')).toHaveTextContent(
      "We couldn't load the widget",
    );
    expect(screen.queryByTestId('webchat-preview-frame')).toBeNull();
  });
});
