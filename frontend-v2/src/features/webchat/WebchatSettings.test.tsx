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
import heChannelsMessages from '@/i18n/messages/he/channels.json';

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
/* W3/W4: the upload is the platform's - mocked here, nothing leaves. */
const browser = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/client/browser-api', () => ({ browserApi: browser }));
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

import { brandInitial, brandMark, initials, inkOn, logoFit } from '@/lib/brand-mark';

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
  browser.post.mockReset();
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
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#12' } });
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#123456' } });
    await pause();
    expect(sentAt().appearance.primaryColor).toBe('#123456');
  });

  it('★★ W4: an image by link (Drive too) is re-hosted, and its new address saved', async () => {
    browser.post.mockResolvedValue({ url: 'https://cdn.gotcha.test/w/cover.png' });
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    fireEvent.change(screen.getByTestId('webchat-cover-url'), {
      target: { value: 'https://drive.google.com/file/d/abc/view' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-cover-add'));
    });
    expect(browser.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/uploads/widget-image' },
      body: { slot: 'cover', url: 'https://drive.google.com/file/d/abc/view' },
    });
    await pause();
    expect(bodyOfWidget(sentAt()).ux.hero).toEqual({
      mediaType: 'image',
      mediaUrl: 'https://cdn.gotcha.test/w/cover.png',
    });
  });

  it('a link that is not https: refused in words, nothing sent', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    const field = screen.getByTestId('webchat-cover-url');
    fireEvent.change(field, { target: { value: 'http://x.co/a.png' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-cover-add'));
    });
    expect(screen.getByTestId('webchat-cover-problem')).toHaveTextContent('start with https://');
    expect(browser.post).not.toHaveBeenCalled();
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
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
    // The launcher carries the initial now (design 7; supervisor, 2026-10-14).
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveTextContent(/^A$/);
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
    // W2: the disc's row carries it now (the disc is inside it).
    const row = /\n {2}\.logoRow \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(row).toMatch(/position: relative/);
    expect(row).toMatch(/z-index: [1-9]/);
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
    // A live change on the customer's site: asked first.
    expect(screen.getByTestId('webchat-kind-ask')).toHaveTextContent(
      'Switch the widget on your site to a WhatsApp widget?',
    );
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
    const panel = screen.getByTestId('webchat-preview-wa');
    expect(panel).toHaveTextContent('Chat with us');
    expect(panel).toHaveTextContent("Write here and we'll continue on WhatsApp.");
    // W2: the panel holds only the greeting the business wrote (none here) - its
    // pop-up line is the teaser above the green button, never inside the panel.
    expect(panel).not.toHaveTextContent('Hi');
    expect(screen.getByTestId('webchat-preview-bubble')).toHaveTextContent('Hi');
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
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
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
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
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
    expect(screen.getByTestId('webchat-swatch-custom')).toBeInTheDocument();
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

describe('★★ W5 (2026-10-14) - the colour: the custom swatch opens the picker; the screen’s eyedropper where there is one', () => {
  it('★ the custom swatch is a control: it opens the square, the hue and the code; a palette colour closes them', () => {
    show('appearance');
    expect(screen.queryByTestId('webchat-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    expect(screen.getByTestId('webchat-swatch-custom')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('webchat-hex')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('webchat-swatch-4F7A2E'));
    expect(screen.queryByTestId('webchat-picker')).toBeNull();
  });

  it('a custom colour opens with its picker open', () => {
    show('appearance', {
      initial: { ...config, appearance: { ...config.appearance, primaryColor: '#123456' } },
    });
    expect(screen.getByTestId('webchat-picker')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-swatch-custom')).toHaveAttribute('aria-pressed', 'true');
  });

  it('★★ #RGB is written out to six digits - the route keeps only those', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    fireEvent.change(screen.getByTestId('webchat-hex'), { target: { value: '#a1c' } });
    await pause();
    expect(sentAt().appearance.primaryColor).toBe('#AA11CC');
  });

  it('★ no eyedropper in a browser without one (Firefox, Safari): never a dead button', () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    expect(screen.queryByTestId('webchat-eyedropper')).toBeNull();
  });

  it('★★ where the browser has one: it picks from the screen, and the colour is saved', async () => {
    const open = vi.fn().mockResolvedValue({ sRGBHex: '#3e5c99' });
    vi.stubGlobal(
      'EyeDropper',
      class {
        open = open;
      },
    );
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-eyedropper'));
    });
    expect(open).toHaveBeenCalled();
    await pause();
    expect(sentAt().appearance.primaryColor).toBe('#3E5C99');
    vi.unstubAllGlobals();
  });

  it('Esc in the eyedropper (it rejects): nothing changes, nothing said', async () => {
    vi.stubGlobal(
      'EyeDropper',
      class {
        open = () => Promise.reject(new DOMException('cancelled', 'AbortError'));
      },
    );
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-swatch-custom'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-eyedropper'));
    });
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('★★ W1, measured on dev - asked first both ways, and "Continue on WhatsApp" put back', () => {
  const NUMS: readonly HandoffNumber[] = [
    { channelId: 'wa1', name: 'Lumière', phone: '+972 54 000 0000', available: true },
  ];

  it('★★ Cancel: nothing saved, nothing changed', async () => {
    show('appearance', { numbers: NUMS });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    fireEvent.click(screen.getByTestId('webchat-kind-ask-no'));
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
    expect(screen.getByTestId('webchat-kind-chat')).toHaveAttribute('aria-checked', 'true');
  });

  it('★★ back to chat is asked too, and puts back the hand-off as it was before - never the widget’s number', async () => {
    const off = {
      ...config,
      ux: { ...config.ux, whatsapp: { enabled: true, channelAccountId: null } },
    };
    show('appearance', { numbers: NUMS, initial: off });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
    await pause();
    fireEvent.click(screen.getByTestId('webchat-kind-chat'));
    expect(screen.getByTestId('webchat-kind-ask')).toHaveTextContent(
      'Switch the widget on your site to a chat widget',
    );
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
    await pause();
    const last = actions.saveWebsiteWidget.mock.calls.at(-1)![0] as WidgetSettings;
    expect(bodyOfWidget(last, { stageB: true }).ux).toMatchObject({
      kind: 'chat',
      look: 'gotcha',
      whatsapp: { enabled: true, channelAccountId: null },
    });
  });

  it('★ opened on a WhatsApp widget, back to chat: the hand-off is off - no number nobody chose', async () => {
    const wa = {
      ...config,
      ux: {
        ...config.ux,
        kind: 'whatsapp' as const,
        look: 'whatsapp' as const,
        whatsapp: { enabled: true, channelAccountId: 'wa1' },
      },
    };
    show('appearance', { numbers: NUMS, initial: wa });
    fireEvent.click(screen.getByTestId('webchat-kind-chat'));
    fireEvent.click(screen.getByTestId('webchat-kind-ask-yes'));
    await pause();
    expect(bodyOfWidget(sentAt(), { stageB: true }).ux).toMatchObject({
      kind: 'chat',
      whatsapp: { enabled: false, channelAccountId: null },
    });
  });

  it('★ "needs a number" is said only while WhatsApp is being chosen - chat clears it', () => {
    show('appearance', { numbers: [] });
    fireEvent.click(screen.getByTestId('webchat-kind-whatsapp'));
    expect(screen.getByTestId('webchat-kind-no-number')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('webchat-kind-chat'));
    expect(screen.queryByTestId('webchat-kind-no-number')).toBeNull();
    expect(screen.queryByTestId('webchat-kind-ask')).toBeNull();
  });
});

describe('W6 (2026-10-14) - the header says what is true at every width and on every workspace', () => {
  it('no platform it may not have, and no side the preview may not be on', () => {
    for (const messages of [channelsMessages, heChannelsMessages]) {
      const line = messages.webchat.subtitle;
      expect(line).not.toMatch(/Shopify/);
      expect(line).not.toMatch(/right|left|מימין|משמאל/i);
    }
  });
});

describe('★★ W3 (2026-10-14) - each image slot says its limits, and refuses what breaks them in words', () => {
  const pick = (testid: string, file: File) =>
    act(async () => {
      fireEvent.change(screen.getByTestId(`${testid}-file`), { target: { files: [file] } });
    });

  it('the logo says its limits; the cover its own', () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-logo-replace'));
    expect(screen.getByTestId('webchat-logo-limits')).toHaveTextContent(
      'up to 1 MB and 1024×1024 pixels',
    );
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    expect(screen.getByTestId('webchat-cover-limits')).toHaveTextContent(
      'up to 3 MB and 2400×1600 pixels',
    );
  });

  it('★★ a file is uploaded as itself, with its slot; its new address is the logo', async () => {
    browser.post.mockResolvedValue({ url: 'https://cdn.gotcha.test/w/logo.png' });
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-logo-replace'));
    await pick('webchat-logo', new File(['x'], 'logo.png', { type: 'image/png' }));
    const body = browser.post.mock.calls[0]![0].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('slot')).toBe('logo');
    expect((body.get('file') as File).name).toBe('logo.png');
    await pause();
    expect(sentAt().appearance.logoUrl).toBe('https://cdn.gotcha.test/w/logo.png');
  });

  it('★ not an image, or too heavy: refused before anything is sent', async () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-logo-replace'));
    await pick('webchat-logo', new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }));
    expect(screen.getByTestId('webchat-logo-problem')).toHaveTextContent(
      "That isn't an image we can use",
    );
    await pick(
      'webchat-logo',
      new File([new Uint8Array(1_000_001)], 'big.png', { type: 'image/png' }),
    );
    expect(screen.getByTestId('webchat-logo-problem')).toHaveTextContent(
      'The file is too big: up to 1 MB.',
    );
    expect(browser.post).not.toHaveBeenCalled();
  });

  it('★★ the server’s refusals in words - the pixel size, a Drive file not shared', async () => {
    const { ApiError } = await import('@/api/client/api-error');
    browser.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 422,
        code: 'IMAGE_DIMENSIONS_TOO_LARGE',
        maxWidth: 1024,
        maxHeight: 1024,
        width: 1200,
        height: 1200,
      }),
    );
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-logo-replace'));
    await pick('webchat-logo', new File(['x'], 'l.png', { type: 'image/png' }));
    expect(screen.getByTestId('webchat-logo-problem')).toHaveTextContent(
      'The image is 1200×1200 pixels; this place takes up to 1024×1024.',
    );
    browser.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 422, code: 'NOT_AN_IMAGE' }),
    );
    fireEvent.change(screen.getByTestId('webchat-logo-url'), {
      target: { value: 'https://drive.google.com/file/d/x/view' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webchat-logo-add'));
    });
    expect(screen.getByTestId('webchat-logo-problem')).toHaveTextContent(
      'must be shared with anyone with the link',
    );
    await pause();
    expect(actions.saveWebsiteWidget).not.toHaveBeenCalled();
  });

  it('Remove clears the image', async () => {
    show('appearance', {
      initial: {
        ...config,
        appearance: { ...config.appearance, logoUrl: 'https://cdn.gotcha.test/l.png' },
      },
    });
    // On the row itself, without opening anything, and named for its slot.
    expect(screen.getByTestId('webchat-logo-remove')).toHaveAccessibleName('Remove the logo');
    fireEvent.click(screen.getByTestId('webchat-logo-remove'));
    await pause();
    expect(sentAt().appearance.logoUrl).toBeNull();
  });
});

describe('★★ W11 (2026-10-14) - Install offers only the platforms connected to GOTCHA', () => {
  const platforms = (shopify: string, woocommerce: string) => [
    { platform: 'shopify', data: shopify, dataErrorCode: null, chat: 'none', stores: [] },
    { platform: 'woocommerce', data: woocommerce, dataErrorCode: null, chat: 'plugin', stores: [] },
  ];

  it('★★ dev’s case: Shopify in error says it needs reconnecting, WooCommerce is offered, the code always', () => {
    show('install', { read: install({ platforms: platforms('error', 'connected') }) });
    expect(screen.getByTestId('webchat-shopify-reconnect')).toHaveTextContent(
      'The connection to Shopify needs reconnecting.',
    );
    expect(screen.queryByTestId('webchat-shopify')).toBeNull();
    expect(screen.getByTestId('webchat-woo')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-snippet')).toBeInTheDocument();
  });

  it('★ not connected, or still connecting: not shown at all', () => {
    show('install', { read: install({ platforms: platforms('not_connected', 'connecting') }) });
    expect(screen.queryByTestId('webchat-shopify')).toBeNull();
    expect(screen.queryByTestId('webchat-shopify-reconnect')).toBeNull();
    expect(screen.queryByTestId('webchat-woo')).toBeNull();
    expect(screen.getByTestId('webchat-snippet')).toBeInTheDocument();
  });

  it('a state it does not know is not offered; an older server (no platforms) offers what it did', () => {
    const { unmount } = show('install', {
      read: install({ platforms: platforms('weird', 'connected') }),
    });
    expect(screen.queryByTestId('webchat-shopify')).toBeNull();
    unmount();
    show('install');
    expect(screen.getByTestId('webchat-shopify')).toBeInTheDocument();
    expect(screen.getByTestId('webchat-woo')).toBeInTheDocument();
  });

  it('Hebrew: the reconnect line', () => {
    const { container } = render(
      <NextIntlClientProvider locale="he" messages={{ channels: heChannelsMessages }}>
        <p>{heChannelsMessages.webchat.install.reconnect}</p>
      </NextIntlClientProvider>,
    );
    expect(container).toHaveTextContent('צריך חיבור מחדש');
  });
});

describe('★ "Right away" is one second (design 7; Omer, 2026-10-14)', () => {
  it('it sends 1, and a stored 0 reads as "right away"', async () => {
    const zero = {
      ...config,
      ux: { ...config.ux, proactive: { ...config.ux.proactive, enabled: true, delaySeconds: 0 } },
    };
    show('behaviour', { initial: zero });
    expect(screen.getByTestId('webchat-when-1')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('webchat-when-1')).toHaveTextContent('Right away');
    fireEvent.click(screen.getByTestId('webchat-when-15'));
    fireEvent.click(screen.getByTestId('webchat-when-1'));
    await pause();
    expect(bodyOfWidget(sentAt()).ux.proactive.delaySeconds).toBe(1);
  });
});

describe('★ dev, 2026-10-14: after an upload, Remove is still there - and the link field has a name', () => {
  it('uploaded: the area closes, the row keeps its own Remove, which clears and saves', async () => {
    browser.post.mockResolvedValue({ url: 'https://cdn.gotcha.test/w/logo.png' });
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-logo-replace'));
    await act(async () => {
      fireEvent.change(screen.getByTestId('webchat-logo-file'), {
        target: { files: [new File(['x'], 'l.png', { type: 'image/png' })] },
      });
    });
    await pause();
    expect(screen.queryByTestId('webchat-logo-file')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the logo' }));
    await pause();
    expect(sentAt(1).appearance.logoUrl).toBeNull();
  });

  it('the link field is found by its name', () => {
    show('appearance');
    fireEvent.click(screen.getByTestId('webchat-cover-replace'));
    expect(screen.getByRole('textbox', { name: 'Link to the image' })).toBe(
      screen.getByTestId('webchat-cover-url'),
    );
  });
});

describe('★★ W2 (2026-10-14) - the preview is design 7’s', () => {
  it('★ the chat widget: cover, logo disc, name, the questions as rows (no arrows), the composer and powered-by', () => {
    show('appearance');
    const widget = screen.getByTestId('webchat-preview-widget');
    expect(widget).toContainElement(screen.getByTestId('webchat-preview-cover'));
    expect(widget).toContainElement(screen.getByTestId('webchat-preview-logo'));
    expect(screen.getByTestId('webchat-preview-questions').querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByTestId('webchat-preview-questions').querySelector('svg')).toBeNull();
    expect(widget).toContainElement(screen.getByTestId('webchat-preview-powered'));
    // The pop-up and the button sit on the stage, outside the widget.
    expect(widget).not.toContainElement(screen.getByTestId('webchat-preview-bubble'));
    expect(widget).not.toContainElement(screen.getByTestId('webchat-preview-launcher'));
  });

  it('★★ the WhatsApp widget: its greeting in the panel, its line above the green button', () => {
    const wa = {
      ...config,
      ux: {
        ...config.ux,
        kind: 'whatsapp' as const,
        look: 'whatsapp' as const,
        welcome: { ...config.ux.welcome, title: 'Hi! How can we help?' },
      },
    };
    show('conversation', { numbers: [], initial: wa });
    expect(screen.getByTestId('webchat-preview-greeting')).toHaveTextContent(
      'Hi! How can we help?',
    );
    expect(screen.getByTestId('webchat-preview-wa')).toHaveTextContent('Type a message');
    expect(screen.getByTestId('webchat-preview-bubble')).toHaveTextContent(/^Hi✕?$/);
    expect(screen.getByTestId('webchat-preview-launcher')).toHaveAttribute('data-look', 'whatsapp');
  });

  it('a pop-up switched off draws no teaser', () => {
    show('appearance', {
      initial: {
        ...config,
        ux: { ...config.ux, proactive: { ...config.ux.proactive, enabled: false } },
      },
    });
    expect(screen.queryByTestId('webchat-preview-bubble')).toBeNull();
  });
});

describe('★★ the bubble and the pop-up carry the brand, as the live widget does (supervisor, 2026-10-14)', () => {
  it("the brand's initial: a whole grapheme, its first letter or digit (Backend's rule)", () => {
    expect(brandInitial('Urban Supply - GOTCHA Demo')).toBe('U');
    expect(brandInitial('  שָׁלוֹם')).toBe('שָׁ');
    expect(brandInitial('élan')).toBe('É');
    expect(brandInitial('"Urban" Supply')).toBe('U');
    expect(brandInitial('🌿 Leaf & Co')).toBe('L');
    expect(brandInitial('123 Shoes')).toBe('1');
    expect(brandInitial('   ')).toBe('');
  });

  it('text on the main colour: cream on a dark one, ink on a pale one', () => {
    expect(inkOn('#2B2622')).toBe('#FBF8F3');
    expect(inkOn('#f5e6c8')).toBe('#2B2622');
    expect(inkOn('#C96A4B')).toBe('#2B2622');
    expect(inkOn('#3E5C99')).toBe('#FBF8F3');
  });

  it('★ the launcher: the initial, in the ink that reads on the colour, and the online dot', () => {
    show('appearance', {
      initial: { ...config, appearance: { ...config.appearance, primaryColor: '#f5e6c8' } },
    });
    const launcher = screen.getByTestId('webchat-preview-launcher');
    expect(launcher).toHaveTextContent(/^A$/);
    expect(launcher).toHaveStyle({ backgroundColor: '#f5e6c8', color: '#2B2622' });
    expect(launcher.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it('★ the pop-up: who is writing and that they answer right away, a ✕, then the message', () => {
    show('appearance');
    const bubble = screen.getByTestId('webchat-preview-bubble');
    expect(bubble).toHaveTextContent(/^AAviv assistantreplies right away✕Hi$/);
    expect(screen.getByTestId('webchat-preview-popup-message')).toHaveTextContent(/^Hi$/);
  });
});

describe("★ our logo at design 7's visible size (dev, 2026-10-14)", () => {
  it('the cropped mark is set at the share of the padded image the mark fills (303 of 768)', () => {
    const css = readFileSync(join(__dirname, 'Webchat.module.css'), 'utf8');
    const rule = (selector: string) =>
      new RegExp(`\\n {2}${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const visible = (designPx: number) => `block-size: ${Math.round((designPx * 303) / 768)}px;`;
    expect(rule('.powered .poweredLogo')).toContain(visible(22));
    expect(rule('.waWidget .powered .poweredLogo')).toContain(visible(28));
    expect(rule('.poweredLogo')).toContain(visible(30));
    // The padded image's negative margins have nothing to cancel on a cropped mark.
    expect(css).not.toMatch(/poweredLogo \{[^}]*margin/);
  });
});
