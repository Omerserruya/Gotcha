import { describe, expect, it } from 'vitest';

import {
  bodyOfWidget,
  previewSite,
  widgetInstallSchema,
  widgetSettingsSchema,
} from './website-widget';

/** The settings as the route keeps them, the least of them. */
const read = (ux: Record<string, unknown> = {}) =>
  widgetSettingsSchema.parse({
    appearance: { primaryColor: '#121212', logoUrl: null, language: 'auto', showPoweredBy: true },
    ux: {
      welcome: { assistantName: 'Noa', suggestedQuestions: [] },
      launcher: { position: 'right' },
      hero: { mediaType: 'none', mediaUrl: null },
      proactive: { enabled: false, trigger: 'time_on_page', delaySeconds: 5, message: '' },
      ...ux,
    },
  });

describe('★★ W1 - the widget’s kind, and the WhatsApp greeting (Backend 2a2ab2af)', () => {
  it('kind read as sent; absent or unknown is chat', () => {
    expect(read({ kind: 'whatsapp' }).ux.kind).toBe('whatsapp');
    expect(read().ux.kind).toBe('chat');
    expect(read({ kind: 'sms' }).ux.kind).toBe('chat');
  });

  it('the welcome title (the WhatsApp greeting) is read, and absent is empty', () => {
    expect(
      read({ welcome: { title: 'Hi!', assistantName: 'Noa', suggestedQuestions: [] } }).ux.welcome
        .title,
    ).toBe('Hi!');
    expect(read().ux.welcome.title).toBe('');
  });

  it('★ the kind is sent only to a service that keeps it (stage B); the title always', () => {
    const settings = read({ kind: 'whatsapp' });
    expect(bodyOfWidget(settings, { stageB: true }).ux).toMatchObject({ kind: 'whatsapp' });
    expect(bodyOfWidget(settings).ux).not.toHaveProperty('kind');
    expect(bodyOfWidget(settings).ux.welcome).toHaveProperty('title', '');
  });
});

describe("★ the preview's address: a connected store, else the website, else where the code was seen (supervisor, dev 2026-10-14)", () => {
  const install = (platforms: unknown, lastHost: string | null = 'seen.example') =>
    widgetInstallSchema.parse({
      data: {
        code: {
          widgetId: 'w',
          snippet: '',
          status: 'live',
          firstSeenAt: null,
          lastSeenAt: null,
          lastHost,
        },
        shopify: [
          {
            channelId: 'c',
            shopDomain: 'urban-supply-gotcha-demo.myshopify.com',
            status: 'active',
            embedLive: false,
            lastHeartbeatAt: null,
          },
        ],
        platforms,
      },
    }).data;

  it("dev's case: Shopify in error is not the address; the connected Woo store is", () => {
    const read = install([
      { platform: 'shopify', data: 'error', stores: ['urban-supply-gotcha-demo.myshopify.com'] },
      { platform: 'woocommerce', data: 'connected', stores: ['https://demo-store.28042000.xyz/'] },
    ]);
    expect(previewSite(read, 'urban.example')).toBe('demo-store.28042000.xyz');
  });

  it('no store connected: the workspace website, as a host', () => {
    const read = install([{ platform: 'shopify', data: 'not_connected', stores: [] }]);
    expect(previewSite(read, ' https://www.urban.example/shop ')).toBe('www.urban.example');
    expect(previewSite(read, 'urban.example')).toBe('urban.example');
  });

  it('neither: where the code was last seen; nothing at all: nothing', () => {
    expect(previewSite(install([]), null)).toBe('seen.example');
    expect(previewSite(install([], null), null)).toBeNull();
    expect(previewSite(null, null)).toBeNull();
  });

  it('a connected platform whose store list is missing or empty falls through', () => {
    const read = install([{ platform: 'woocommerce', data: 'connected' }]);
    expect(read.platforms![0]!.stores).toEqual([]);
    expect(previewSite(read, 'urban.example')).toBe('urban.example');
  });
});
