import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bodyOfConfig, webchatSettingsSchema, type WebchatConfig } from '@/api/contracts/webchat';
import {
  bodyOfWidget,
  widgetInstallSchema,
  type HandoffNumber,
  type WebsiteWidget,
  type WidgetInstall,
  type WidgetSettings,
} from '@/api/contracts/website-widget';
import channelsMessages from '@/i18n/messages/en/channels.json';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => router,
}));
const actions = vi.hoisted(() => ({ saveWebsiteWidget: vi.fn() }));
vi.mock('./website-widget-actions', () => actions);
const channelActions = vi.hoisted(() => ({ connectWebChat: vi.fn() }));
vi.mock('@/features/channels/actions', () => channelActions);
// The existing install (10 / 00g), tested where it lives: here, only that it is the one used.
vi.mock('@/features/capabilities/ShopifyConnect', () => ({
  ShopifyConnect: ({ mode }: { mode: string | null }) => (
    <button type="button" data-testid="shopify-connect" data-mode={mode ?? 'unread'}>
      Connect Shopify
    </button>
  ),
}));

import type { WebchatTab } from '@/api/contracts/webchat';

import { brandMark, initials, logoFit } from '@/lib/brand-mark';

import type { ShopifyData } from './load-website-widget';
import { SAVE_AFTER_MS, WebchatSettings } from './WebchatSettings';

const config: WebchatConfig = webchatSettingsSchema.parse({
  data: {
    displayName: '',
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

const SNIPPET = '<script>window.__chatcenter = { widgetId: "widget_1" };</script>';

const install = (over: Record<string, unknown> = {}): WidgetInstall =>
  widgetInstallSchema.parse({
    data: {
      code: {
        widgetId: 'widget_1',
        snippet: SNIPPET,
        status: 'not_seen',
        firstSeenAt: null,
        lastSeenAt: null,
        lastHost: null,
      },
      shopify: [],
      woocommerce: { status: 'use_code' },
      ...over,
    },
  }).data;

const shop = (over: Record<string, unknown> = {}) => ({
  channelId: 'sc1',
  shopDomain: 'lumiere.myshopify.com',
  status: 'active',
  embedLive: true,
  lastHeartbeatAt: null,
  themeEditorUrl: 'https://admin.shopify.com/store/lumiere/themes/current/editor',
  ...over,
});

const show = (
  tab: WebchatTab,
  {
    read = install(),
    data = 'ok',
    assigned = null,
    numbers = null,
    initial = config,
  }: {
    read?: WidgetInstall | null;
    data?: ShopifyData | null;
    assigned?: WebsiteWidget['assignedEmployee'];
    /** Stage B's numbers; `null` is a stage A service. */
    numbers?: readonly HandoffNumber[] | null;
    initial?: WebchatConfig;
  } = {},
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: channelsMessages }}>
      <WebchatSettings
        initial={initial}
        assigned={assigned}
        install={read}
        shopifyData={data}
        shopifyAvailability={{ mode: 'listing', helpUrl: null }}
        business="Aviv & Co."
        tab={tab}
        handoffNumbers={numbers}
      />
    </NextIntlClientProvider>,
  );

const sentAt = (i = 0) => actions.saveWebsiteWidget.mock.calls[i]?.[0] as WidgetSettings;

beforeEach(() => {
  vi.useFakeTimers();
  actions.saveWebsiteWidget.mockReset();
  actions.saveWebsiteWidget.mockImplementation((settings: WidgetSettings) =>
    Promise.resolve({ ok: true, settings }),
  );
  channelActions.connectWebChat.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const pause = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS);
  });

describe('★★ no Save button: a change is saved after a pause, the last one winning', () => {
  it('two quick changes are one save, of the last, to the one widget; the preview shows it at once', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-4F7A2E'));
    fireEvent.click(screen.getByTestId('webchat-position-left'));
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveStyle({
      backgroundColor: '#4F7A2E',
    });
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    await pause();
    expect(actions.saveWebsiteWidget).toHaveBeenCalledTimes(1);
    expect(sentAt().appearance.primaryColor).toBe('#4F7A2E');
    expect(sentAt().ux.launcher.position).toBe('left');
    // The account's name is not a widget setting: never sent.
    expect(sentAt()).not.toHaveProperty('displayName');
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent('Saved');
  });

  it('a failed save says so - never "Saved"', async () => {
    actions.saveWebsiteWidget.mockResolvedValue({ ok: false, reason: 'failed' });
    show('behaviour');
    fireEvent.click(screen.getByTestId('webchat-popup-switch'));
    await pause();
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent('Not saved');
    expect(screen.getByTestId('webchat-saving')).not.toHaveTextContent(/^Saved$/);
  });

  it('★ installed nowhere yet (409 WIDGET_NOT_CREATED): says to get the code first, not "try again"', async () => {
    actions.saveWebsiteWidget.mockResolvedValue({ ok: false, reason: 'nowhere' });
    show('behaviour', { read: install({ code: null }) });
    fireEvent.click(screen.getByTestId('webchat-popup-switch'));
    await pause();
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent('Get the code under Install');
    expect(screen.getByTestId('webchat-saving')).not.toHaveTextContent('Change it again');
  });

  it('a half-typed colour is never saved; a whole one is', async () => {
    show('appearance');
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#12' } });
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#123456' } });
    await pause();
    expect(sentAt().appearance.primaryColor).toBe('#123456');
  });

  it('an image address is saved only when it is https', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    const field = screen.getByTestId('webchat-cover-url');
    fireEvent.change(field, { target: { value: 'http://x.co/a.png' } });
    fireEvent.blur(field);
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'https://x.co/a.png' } });
    fireEvent.blur(field);
    await pause();
    expect(bodyOfWidget(sentAt()).ux.hero).toEqual({
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
    expect(bodyOfWidget(sentAt()).ux.welcome.suggestedQuestions).toEqual([
      'Where is my order?',
      'Can I exchange?',
    ]);
  });

  it('★ the body is the web chat body without the account name', () => {
    const { displayName: _name, ...settings } = config;
    const { displayName: _sent, ...expected } = bodyOfConfig(config);
    expect(bodyOfWidget(settings)).toEqual(expected);
    expect(bodyOfWidget(settings)).not.toHaveProperty('displayName');
  });
});

describe("★★ who answers is the playbook's - read here, never chosen", () => {
  it('names the employee the playbook routes the website to, and where that is decided', () => {
    show('conversation', { assigned: { id: 'a1', name: 'Maya' } });
    expect(screen.getByTestId('webchat-employee-who')).toHaveTextContent('Maya');
    const where = screen.getByTestId('webchat-employee-where');
    expect(where).toHaveTextContent('Studio · Automations');
    expect(where.querySelector('a')).toHaveAttribute('href', '/studio/automations');
    expect(screen.getByTestId('webchat-employee').querySelector('button, input')).toBeNull();
  });

  it('routes to no one employee: says so, never a name', () => {
    show('conversation');
    expect(screen.getByTestId('webchat-employee-who')).toHaveTextContent(
      "The playbook doesn't send website conversations to one employee",
    );
  });
});

describe('★★ products and cart are on by WHERE it runs - a Shopify shop whose catalogue answers', () => {
  it('no shop: products, cart and deals are statuses with a reason, no switch', () => {
    show('behaviour');
    for (const k of ['whatsapp', 'products', 'cart', 'deals']) {
      expect(screen.queryByTestId(`webchat-${k}-switch`)).toBeNull();
      expect(screen.getByTestId(`webchat-${k}-unavailable`)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(screen.getByTestId('webchat-products')).toHaveTextContent(
      'it needs the widget in a Shopify store with stock and orders connected',
    );
    expect(screen.getByTestId('webchat-popup-switch')).toBeEnabled();
  });

  it('★ an active shop whose catalogue answers: "On in your Shopify store", and not from the code', () => {
    show('behaviour', { read: install({ shopify: [shop()] }) });
    for (const k of ['products', 'cart']) {
      expect(screen.getByTestId(`webchat-${k}-on`)).toHaveTextContent('On in your Shopify store');
      expect(screen.getByTestId(`webchat-${k}`)).toHaveTextContent(
        'Not on sites that use the code',
      );
      expect(screen.queryByTestId(`webchat-${k}-switch`)).toBeNull();
    }
    // Deals have no source anywhere.
    expect(screen.getByTestId('webchat-deals-unavailable')).toBeInTheDocument();
  });

  it('⚠ dev: the shop runs the chat but the integration is failing - unavailable, never "On"', () => {
    show('behaviour', { read: install({ shopify: [shop()] }), data: 'failing' });
    expect(screen.queryByTestId('webchat-products-on')).toBeNull();
    expect(screen.getByTestId('webchat-products-unavailable')).toBeInTheDocument();
  });

  it('a shop the app was removed from does not turn them on', () => {
    show('behaviour', { read: install({ shopify: [shop({ status: 'uninstalled' })] }) });
    expect(screen.queryByTestId('webchat-products-on')).toBeNull();
  });
});

describe('★★ install: Shopify by the existing install, WooCommerce coming, any site by the code', () => {
  it('no shop: "Connect Shopify" is the existing install, with its availability', () => {
    show('install');
    expect(screen.getByTestId('webchat-shopify')).toContainElement(
      screen.getByTestId('shopify-connect'),
    );
    expect(screen.getByTestId('shopify-connect')).toHaveAttribute('data-mode', 'listing');
  });

  it('WooCommerce: Coming soon, with why - a status, not a button', () => {
    show('install');
    const woo = screen.getByTestId('webchat-woo-action');
    expect(woo).toHaveAttribute('aria-disabled', 'true');
    expect(woo).toHaveTextContent('Coming soon');
    expect(screen.getByTestId('webchat-woo')).toHaveTextContent(
      'There is no WooCommerce plugin yet',
    );
  });

  it("the snippet is the route's, verbatim; Copy copies exactly it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show('install');
    expect(screen.getByTestId('webchat-snippet-code').textContent).toBe(SNIPPET);
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-copy'));
    });
    expect(writeText).toHaveBeenCalledWith(SNIPPET);
  });

  it('★ no code yet: "Get the code" makes it by the web chat create, then reads again', async () => {
    channelActions.connectWebChat.mockResolvedValue({ ok: true, data: {} });
    show('install', { read: install({ code: null }) });
    expect(screen.queryByTestId('webchat-snippet-code')).toBeNull();
    expect(screen.queryByTestId('webchat-copy')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-get-code'));
    });
    expect(channelActions.connectWebChat).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('the plan has no room: said, and nothing refreshed', async () => {
    channelActions.connectWebChat.mockResolvedValue({ ok: false, reason: 'limit' });
    show('install', { read: install({ code: null }) });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-get-code'));
    });
    expect(screen.getByTestId('webchat-get-code-problem')).toHaveTextContent(
      'Your plan has no room for another channel',
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('the installs could not be read: said, never an empty Install', () => {
    show('install', { read: null });
    expect(screen.getByTestId('webchat-install-unread')).toHaveTextContent(
      "Couldn't read where the widget is installed",
    );
    expect(screen.queryByTestId('webchat-woo')).toBeNull();
    // And no status in the header: unknown is not "Not live yet".
    expect(screen.queryByTestId('webchat-status')).toBeNull();
    expect(screen.queryByTestId('webchat-go-live')).toBeNull();
  });
});

describe('★★ a shop says which Shopify it means: the chat in the theme, then stock and orders', () => {
  it('active and loading, catalogue connected: Active, and connected to stock and orders', () => {
    show('install', { read: install({ shopify: [shop()] }) });
    expect(screen.getByTestId('webchat-shop-domain')).toHaveTextContent(
      /^lumiere\.myshopify\.com$/,
    );
    expect(screen.getByTestId('webchat-shop-line')).toHaveTextContent(
      /^Installed, the chat shows in your theme$/,
    );
    expect(screen.getByTestId('webchat-shop-status')).toHaveTextContent(/^Active$/);
    expect(screen.getByTestId('webchat-shop-data')).toHaveTextContent(
      'Connected to stock and orders',
    );
    // Nothing to do: no button on either line.
    expect(screen.queryByTestId('webchat-shop-data-action')).toBeNull();
    expect(screen.queryByTestId('webchat-shop-theme')).toBeNull();
    expect(screen.queryByTestId('shopify-connect')).toBeNull();
  });

  it('★★ dev: the chat active, the integration failing - says it is failing, never "connected"', () => {
    show('install', { read: install({ shopify: [shop()] }), data: 'failing' });
    const data = screen.getByTestId('webchat-shop-data');
    expect(data).toHaveTextContent("Stock and orders aren't connected: the connection is failing");
    expect(data).not.toHaveTextContent('Connected to stock and orders');
    // Its way forward is a button on its own line, not a link inside the sentence.
    const fix = screen.getByTestId('webchat-shop-data-action');
    expect(fix).toHaveTextContent(/^Fix the connection$/);
    expect(fix).toHaveAttribute('href', '/studio/capabilities');
    expect(fix.className).toMatch(/secondary/);
    expect(screen.getByTestId('webchat-shop-line')).not.toHaveTextContent(/stock|orders/i);
  });

  it('not connected / unread: each said as itself', () => {
    const { unmount } = show('install', { read: install({ shopify: [shop()] }), data: 'none' });
    expect(screen.getByTestId('webchat-shop-data')).toHaveTextContent(
      "Stock and orders aren't connected",
    );
    expect(screen.getByTestId('webchat-shop-data-action')).toHaveTextContent(/^Connect$/);
    unmount();
    show('install', { read: install({ shopify: [shop()] }), data: null });
    expect(screen.getByTestId('webchat-shop-data')).toHaveTextContent(
      "Couldn't check the stock and orders connection",
    );
    expect(screen.queryByTestId('webchat-shop-data-action')).toBeNull();
  });

  it('installed but the theme has not loaded it this week: Not showing, with the theme editor', () => {
    show('install', { read: install({ shopify: [shop({ embedLive: false })] }) });
    expect(screen.getByTestId('webchat-shop-status')).toHaveTextContent('Not showing');
    expect(screen.getByTestId('webchat-shop-line')).toHaveTextContent(
      "Installed, but the store's theme hasn't loaded the chat in the last week",
    );
    const theme = screen.getByTestId('webchat-shop-theme');
    expect(theme).toHaveAttribute(
      'href',
      'https://admin.shopify.com/store/lumiere/themes/current/editor',
    );
    // A quiet button beside the badge, not a link in the text.
    expect(theme.className).toMatch(/secondary/);
    expect(screen.getByTestId('webchat-shop-line')).not.toContainElement(theme);
    // ★ The button and the badge share the name's row; the shop and its status
    //   are below it, so neither squeezes them (dev: the domain cut in four lines).
    const nameRow = theme.parentElement!;
    expect(nameRow).toContainElement(screen.getByTestId('webchat-shop-status'));
    expect(nameRow).not.toContainElement(screen.getByTestId('webchat-shop-domain'));
    expect(nameRow).not.toContainElement(screen.getByTestId('webchat-shop-line'));
  });

  it('switched off in the theme: Off, with the theme editor, and no stock line', () => {
    show('install', { read: install({ shopify: [shop({ status: 'not_enabled' })] }) });
    expect(screen.getByTestId('webchat-shop-status')).toHaveTextContent(/^Off$/);
    expect(screen.getByTestId('webchat-shop-theme')).toBeInTheDocument();
    expect(screen.queryByTestId('webchat-shop-data')).toBeNull();
  });

  it('★ the app was removed: said, and the way back is the install, not a chip', () => {
    show('install', { read: install({ shopify: [shop({ status: 'uninstalled' })] }) });
    expect(screen.getByTestId('webchat-shop-sc1')).toHaveTextContent(
      'The GOTCHA app was removed from this store',
    );
    expect(screen.queryByTestId('webchat-shop-status')).toBeNull();
    expect(screen.getByTestId('webchat-shop-sc1')).toContainElement(
      screen.getByTestId('shopify-connect'),
    );
  });

  it('an unknown shop status fails the read - never guessed into "Active"', () => {
    expect(() => install({ shopify: [shop({ status: 'paused' })] })).toThrow();
  });
});

describe("★ live is the installs' to say: the code seen on a page, or a shop whose theme loads it", () => {
  it('not live: Go live opens Install, and the strip waits for the first visit', () => {
    show('install');
    expect(screen.getByTestId('webchat-status')).toHaveTextContent('Not live yet');
    expect(screen.getByTestId('webchat-go-live').getAttribute('href')).toContain('"tab":"install"');
    expect(screen.getByTestId('webchat-install-status')).toHaveTextContent(
      'Waiting for the first visit',
    );
  });

  it('the code seen on a page: Live, where it was last seen, and no Go live', () => {
    show('install', {
      read: install({
        code: {
          widgetId: 'widget_1',
          snippet: SNIPPET,
          status: 'live',
          lastHost: 'avivco.il',
        },
      }),
    });
    expect(screen.getByTestId('webchat-status')).toHaveTextContent('Live');
    expect(screen.queryByTestId('webchat-go-live')).toBeNull();
    expect(screen.getByTestId('webchat-install-status')).toHaveTextContent(
      'Live. Last seen on avivco.il',
    );
  });

  it('a shop whose theme loads it is live; one that is only installed is not', () => {
    const { unmount } = show('appearance', { read: install({ code: null, shopify: [shop()] }) });
    expect(screen.getByTestId('webchat-status')).toHaveTextContent(/^Live$/);
    unmount();
    show('appearance', { read: install({ code: null, shopify: [shop({ embedLive: false })] }) });
    expect(screen.getByTestId('webchat-status')).toHaveTextContent('Not live yet');
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

  it('★★ the logo is sized by its longest word, never broken in one; initials when none fits', () => {
    // dev: "URBAN SUPPL / Y" across three lines in the circle.
    expect(logoFit('AVIV & CO.')).toBe('l');
    expect(logoFit('URBAN SUPPLY')).toBe('m');
    expect(logoFit('LUMIÈRE')).toBe('s');
    expect(logoFit('LUMIÈREPARIS')).toBe('initials');
    expect(initials('Urban Supply - GOTCHA demo store')).toBe('US');
    expect(initials('Aviv & Co.')).toBe('AC');
    expect(initials('Lumièreparis')).toBe('LU');
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={{ channels: channelsMessages }}>
        <WebchatSettings
          initial={config}
          assigned={null}
          install={install()}
          shopifyData="ok"
          shopifyAvailability={null}
          business="Urban Supply - GOTCHA demo store"
          tab="appearance"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('webchat-preview-logo')).toHaveAttribute('data-fit', 'm');
    expect(screen.getByTestId('webchat-preview-logo')).toHaveTextContent('URBAN SUPPLY');
    unmount();
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: channelsMessages }}>
        <WebchatSettings
          initial={config}
          assigned={null}
          install={install()}
          shopifyData="ok"
          shopifyAvailability={null}
          business="Lumièreparis"
          tab="appearance"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('webchat-preview-logo')).toHaveTextContent(/^LU$/);
  });

  it('★ the mark sits ABOVE the cover it overlaps (dev: "URBAN" was under the cover, 4cbbcc0)', () => {
    // jsdom does no layout; Chromium measured it - this holds the rule that fixed it.
    const css = readFileSync(join(__dirname, 'Webchat.module.css'), 'utf8');
    const logo = /\n {2}\.logo \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(logo).toMatch(/position: relative/);
    expect(logo).toMatch(/z-index: [1-9]/);
  });

  it('★ a status where a switch would be fills its row (dev: "Show active deals" was narrower)', () => {
    const css = readFileSync(join(__dirname, 'Webchat.module.css'), 'utf8');
    expect(css).toMatch(/\.toggleRow > \[data-unavailable\] \{\s*flex: 1 1 100%;/);
  });

  it('★ the mark’s CSS lets no word break - the sizes above are what keep it inside', () => {
    const css = readFileSync(join(__dirname, 'Webchat.module.css'), 'utf8');
    const logo = /\n {2}\.logo \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(logo).toMatch(/word-break: keep-all/);
    expect(logo).not.toMatch(/anywhere|break-all|break-word/);
  });
});

describe('★★ stage B - the look and "Continue on WhatsApp" (website-widget-v1 §1)', () => {
  const NUMBERS: readonly HandoffNumber[] = [
    { channelId: 'wa1', name: 'Lumière', phone: '+972 54 000 0000', available: true },
    {
      channelId: 'wa2',
      name: 'Old line',
      phone: null,
      available: false,
      reason: 'number_unknown',
    },
    {
      channelId: 'wa3',
      name: 'Off line',
      phone: '+972 3 555 0000',
      available: false,
      reason: 'not_connected',
    },
  ];
  const lastStageB = () => actions.saveWebsiteWidget.mock.calls.at(-1)?.[1];

  it('★ a stage A service: both are drawn unavailable, with why - and never sent', async () => {
    show('appearance');
    // No kind to choose on a service that cannot keep it (W1).
    expect(screen.queryByTestId('webchat-kind')).toBeNull();
    fireEvent.click(screen.getByTestId('webchat-position-left'));
    await pause();
    expect(lastStageB()).toBe(false);
    expect(bodyOfWidget(sentAt())).not.toHaveProperty('ux.look');
    expect(bodyOfWidget(sentAt())).not.toHaveProperty('ux.kind');
    expect(bodyOfWidget(sentAt())).not.toHaveProperty('ux.whatsapp');
  });

  it('★★ W1: the WhatsApp widget, chosen above the tabs - its look, its one usable number, saved together', async () => {
    show('appearance', { numbers: NUMBERS });
    expect(screen.getByTestId('webchat-kind-chat')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('webchat-preview-wa')).toBeNull();
    // The Look segment is gone: the kind decides it.
    expect(screen.queryByTestId('webchat-look-whatsapp')).toBeNull();
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    const panel = screen.getByTestId('webchat-preview-wa');
    expect(panel).toHaveTextContent('Chat with us');
    expect(panel).toHaveTextContent("Write here and we'll continue on WhatsApp.");
    // Only what the business wrote: its pop-up message - no sample greeting.
    expect(panel).toHaveTextContent('Hi');
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveAttribute('data-look', 'whatsapp');
    await pause();
    expect(lastStageB()).toBe(true);
    expect(bodyOfWidget(sentAt(), { stageB: true }).ux).toMatchObject({
      kind: 'whatsapp',
      look: 'whatsapp',
      // The only number that can take it: chosen with the kind.
      whatsapp: { enabled: true, channelAccountId: 'wa1' },
    });
    expect(screen.getByTestId('webchat-kind-number')).toHaveTextContent('Lumière');
  });

  it('★★ W1: two usable numbers - picked in place; one that cannot be used says why and cannot be picked', async () => {
    const two = [
      ...NUMBERS,
      { channelId: 'wa4', name: 'Second', phone: '+972 50 1', available: true },
    ];
    show('behaviour', { numbers: two });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    // Not saved yet: a WhatsApp widget is never saved without its number.
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    expect(screen.getByTestId('webchat-kind-number-wa2')).toBeDisabled();
    expect(screen.getByTestId('webchat-kind-numbers')).toHaveTextContent(
      "Its phone number isn't known yet",
    );
    fireEvent.click(screen.getByTestId('webchat-kind-number-wa4'));
    await pause();
    expect(bodyOfWidget(sentAt(), { stageB: true }).ux).toMatchObject({
      kind: 'whatsapp',
      whatsapp: { enabled: true, channelAccountId: 'wa4' },
    });
  });

  it('W1: no number that can take it - said, with where to connect one, nothing saved', async () => {
    show('appearance', { numbers: NUMBERS.filter((n) => !n.available) });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    expect(screen.getByTestId('webchat-kind-no-number')).toHaveTextContent(
      'A WhatsApp widget needs a connected WhatsApp number',
    );
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
  });

  it('★★ W1: a WhatsApp widget shows only its own settings, in every tab', () => {
    const wa = {
      ...config,
      ux: {
        ...config.ux,
        kind: 'whatsapp' as const,
        look: 'whatsapp' as const,
        whatsapp: { enabled: true, channelAccountId: 'wa1' },
      },
    };
    const appearance = show('appearance', { numbers: NUMBERS, initial: wa });
    expect(screen.getByTestId('webchat-wa-look-note')).toBeInTheDocument();
    expect(screen.queryByTestId('webchat-colour')).toBeNull();
    expect(screen.getByTestId('webchat-position')).toBeInTheDocument();
    appearance.unmount();
    const conversation = show('conversation', { numbers: NUMBERS, initial: wa });
    expect(screen.getByTestId('webchat-greeting')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-popup-text')).toHaveTextContent('Line above the button');
    expect(screen.queryByTestId('webchat-name')).toBeNull();
    expect(screen.queryByTestId('webchat-questions')).toBeNull();
    expect(screen.queryByTestId('webchat-employee')).toBeNull();
    expect(screen.queryByTestId('webchat-language')).toBeNull();
    conversation.unmount();
    show('behaviour', { numbers: NUMBERS, initial: wa });
    expect(screen.getByTestId('webchat-popup')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-powered')).toBeInTheDocument();
    expect(screen.queryByTestId('webchat-whatsapp')).toBeNull();
    expect(screen.queryByTestId('webchat-products')).toBeNull();
    expect(screen.queryByTestId('webchat-deals')).toBeNull();
  });

  it('W1: the WhatsApp greeting is saved as the welcome title', async () => {
    const wa = {
      ...config,
      ux: { ...config.ux, kind: 'whatsapp' as const, look: 'whatsapp' as const },
    };
    show('conversation', { numbers: NUMBERS, initial: wa });
    fireEvent.change(screen.getByTestId('webchat-greeting-input'), {
      target: { value: 'Hi there' },
    });
    await pause();
    expect(bodyOfWidget(sentAt(), { stageB: true }).ux.welcome).toMatchObject({
      title: 'Hi there',
    });
  });

  it('W1: the server refusing a WhatsApp widget without a number says so in words', async () => {
    actions.saveWebsiteWidget.mockResolvedValue({ ok: false, reason: 'kindNumber' });
    show('appearance', { numbers: NUMBERS });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    await pause();
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent(
      'a WhatsApp widget needs a connected WhatsApp number',
    );
  });

  it('★ in the WhatsApp look the main colour and the cover say they are not used - no picker that changes nothing', () => {
    const wa = { ...config, ux: { ...config.ux, look: 'whatsapp' as const } };
    const { unmount } = show('appearance', { numbers: NUMBERS, initial: wa });
    expect(screen.getByTestId('webchat-colour-wa-look')).toHaveTextContent(
      "The WhatsApp look uses WhatsApp's colours",
    );
    expect(screen.getByTestId('webchat-colour-wa-look')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('webchat-hex')).toBeNull();
    expect(screen.queryAllByRole('radio', { name: /^#/ })).toHaveLength(0);
    expect(screen.getByTestId('webchat-cover-wa-look')).toHaveTextContent(
      'The WhatsApp look shows no cover image',
    );
    unmount();
    // Back in GOTCHA's look, both are what they were.
    show('appearance', { numbers: NUMBERS });
    expect(screen.getByTestId('webchat-hex')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-cover-replace')).toBeInTheDocument();
  });

  it('★★ Continue on WhatsApp: on, and the one number that can take it is the one', async () => {
    show('behaviour', { numbers: NUMBERS });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    await pause();
    expect(sentAt().ux.whatsapp).toEqual({ enabled: true, channelAccountId: 'wa1' });
    expect(bodyOfWidget(sentAt(), { stageB: true }).ux).toMatchObject({
      whatsapp: { enabled: true, channelAccountId: 'wa1' },
    });
    const one = within(screen.getByTestId('webchat-wa-wa1')).getByRole('radio');
    expect(one).toBeChecked();
    expect(screen.queryByTestId('webchat-wa-hidden')).toBeNull();
  });

  it('★ a number that cannot take it: not choosable, and why, in words', () => {
    show('behaviour', { numbers: NUMBERS });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    expect(within(screen.getByTestId('webchat-wa-wa2')).getByRole('radio')).toBeDisabled();
    expect(screen.getByTestId('webchat-wa-wa2-why')).toHaveTextContent(
      "We don't know this number's phone yet; reconnect it in Settings · Channels",
    );
    expect(screen.getByTestId('webchat-wa-wa2-why').querySelector('a')).toHaveAttribute(
      'href',
      '/settings/channels',
    );
    expect(screen.getByTestId('webchat-wa-wa3-why')).toHaveTextContent(
      "This number isn't connected",
    );
    // The phone as it is, left to right; a number with none says nothing for it.
    expect(screen.getByTestId('webchat-wa-wa1')).toHaveTextContent('+972 54 000 0000');
  });

  it('★★ dev: the only number’s phone is unknown - on, nothing chosen, and said that the button won’t show', async () => {
    show('behaviour', { numbers: [NUMBERS[1]!] });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    expect(screen.getByTestId('webchat-wa-hidden')).toHaveTextContent(
      "The button won't show on your site until a number that can take it is chosen.",
    );
    await pause();
    expect(sentAt().ux.whatsapp).toEqual({ enabled: true, channelAccountId: null });
  });

  it('the preview shows the WhatsApp action only when the button will show', () => {
    const { unmount } = show('behaviour', { numbers: [NUMBERS[1]!] });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    expect(screen.queryByTestId('webchat-preview-wa-button')).toBeNull();
    unmount();
    show('behaviour', { numbers: NUMBERS });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    expect(screen.getByTestId('webchat-preview-wa-button')).toBeInTheDocument();
  });

  it('★ a stored choice of a number that cannot take it: no button in the preview, and said', () => {
    show('behaviour', {
      numbers: NUMBERS,
      initial: {
        ...config,
        ux: { ...config.ux, whatsapp: { enabled: true, channelAccountId: 'wa2' } },
      },
    });
    expect(screen.queryByTestId('webchat-preview-wa-button')).toBeNull();
    expect(screen.getByTestId('webchat-wa-hidden')).toBeInTheDocument();
  });

  it('no WhatsApp number at all: said, with the way to connect one', () => {
    show('behaviour', { numbers: [] });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    expect(screen.getByTestId('webchat-wa-none')).toHaveTextContent(
      'No WhatsApp number is connected yet.',
    );
  });

  it('the route refusing the number (422): said in those words', async () => {
    actions.saveWebsiteWidget.mockResolvedValue({ ok: false, reason: 'number' });
    show('behaviour', { numbers: NUMBERS });
    fireEvent.click(screen.getByTestId('webchat-whatsapp-switch'));
    await pause();
    expect(screen.getByTestId('webchat-saving')).toHaveTextContent(
      "that WhatsApp number isn't one of this workspace's",
    );
  });

  it('the contract: an unknown or absent look is GOTCHA’s; an absent handoff is off', () => {
    const parse = (ux: Record<string, unknown>) =>
      webchatSettingsSchema.parse({
        data: { ...config, ux: { ...config.ux, ...ux } },
      }).data.ux;
    expect(parse({ look: 'neon' }).look).toBe('gotcha');
    const { look: _l, whatsapp: _w, ...stageA } = config.ux;
    expect(webchatSettingsSchema.parse({ data: { ...config, ux: stageA } }).data.ux).toMatchObject({
      look: 'gotcha',
      whatsapp: { enabled: false, channelAccountId: null },
    });
  });
});

describe('★★ W8 (2026-10-14) - "Powered by GOTCHA" is always on, with our logo', () => {
  it('a locked row with the logo - never a switch to turn it off', () => {
    show('behaviour');
    const row = screen.getByTestId('webchat-powered');
    expect(row).toHaveTextContent('Always shown, in both widgets.');
    expect(row.querySelector('input')).toBeNull();
    expect(screen.queryByTestId('webchat-powered-switch')).toBeNull();
    expect(row.querySelector('img')).toHaveAttribute('alt', 'GOTCHA');
    expect(row.querySelector('img')?.getAttribute('src')).toMatch(
      /\/brand\/gotcha-line-dark\.png$/,
    );
  });

  it('★ the body a save sends never carries showPoweredBy - the route refuses false', () => {
    expect(bodyOfConfig(config).appearance).not.toHaveProperty('showPoweredBy');
    expect(
      bodyOfConfig({ ...config, appearance: { ...config.appearance, showPoweredBy: false } })
        .appearance,
    ).not.toHaveProperty('showPoweredBy');
  });

  it('★ the preview shows it with the logo - even if the server ever said false', () => {
    show('appearance', {
      initial: { ...config, appearance: { ...config.appearance, showPoweredBy: false } },
    });
    const line = screen.getByTestId('webchat-preview-powered');
    expect(line).toHaveTextContent('Powered by');
    expect(line.querySelector('img')).toHaveAttribute('alt', 'GOTCHA');
  });
});
