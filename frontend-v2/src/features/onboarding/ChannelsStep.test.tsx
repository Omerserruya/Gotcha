import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import channelsEn from '@/i18n/messages/en/channels.json';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** Step 3. Mocked: nothing connects, no number, page or mailbox is touched. */
const { actions, router } = vi.hoisted(() => ({
  actions: { startChannelConnect: vi.fn() },
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock('@/features/channels/actions', () => actions);
vi.mock('@/features/channels/ConnectWhatsApp', () => ({
  ConnectWhatsApp: ({ closeHref }: { closeHref: string }) => (
    <div data-testid="whatsapp-wizard" data-close={closeHref} />
  ),
}));
vi.mock('@/features/channels/ConnectPanel', () => ({
  EmailStep: ({ note, onClose }: { note?: boolean; onClose: () => void }) => (
    <button type="button" data-testid="email-form" data-note={String(note)} onClick={onClose} />
  ),
}));
vi.mock('@/features/webchat/WebchatSettings', () => ({
  GetTheCode: () => <button type="button" data-testid="get-the-code" />,
  CopyCode: ({ code }: { code: string }) => <span data-testid="copy-code" data-code={code} />,
}));
const stepSave = vi.hoisted(() => ({ saveStep: vi.fn(async () => true) }));
vi.mock('./step-actions', () => stepSave);
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { afterChannels, ChannelsStep } from './ChannelsStep';

const configured = { configured: true, appId: 'a', configId: 'c' };
const config = (over: object = {}) => ({
  launches: { coexistence: configured, newNumber: null },
  providers: { instagram: true },
  ...over,
});
const code = (status: 'live' | 'not_seen') => ({
  code: {
    widgetId: 'w1',
    snippet: '<script>chat</script>',
    status,
    firstSeenAt: null,
    lastSeenAt: null,
    lastHost: null,
  },
  shopify: [],
  woocommerce: { sites: [] },
});
const show = (props: Partial<Parameters<typeof ChannelsStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ onboarding: onboardingEn, channels: channelsEn }}
    >
      <ChannelsStep
        channels={[]}
        install={code('not_seen') as never}
        config={config() as never}
        {...props}
      />
    </NextIntlClientProvider>,
  );
const channel = (type: string, status = 'CONNECTED') =>
  channelSchema.parse({ id: `c-${type}`, channel: type, connectionStatus: status });

beforeEach(() => {
  actions.startChannelConnect.mockReset();
  router.refresh.mockClear();
});

describe('★★ step 3: where customers write - connect here, or skip', () => {
  it('★ the four channels, in order, each with what it is', () => {
    show();
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
      'channels-WEBCHAT',
      'channels-WHATSAPP',
      'channels-INSTAGRAM',
      'channels-EMAIL',
    ]);
    expect(screen.getByTestId('channels-WEBCHAT')).toHaveTextContent('Paste the code once.');
  });

  it('★★ website: the code shown and copied HERE; "ready, not seen" until it is seen on the site', () => {
    show();
    expect(screen.getByTestId('channels-code-snippet')).toHaveTextContent('<script>chat</script>');
    expect(screen.getByTestId('copy-code')).toHaveAttribute('data-code', '<script>chat</script>');
    expect(screen.getByTestId('channels-code-ready-WEBCHAT')).toHaveTextContent(
      'The code is ready. Once you paste it into your site, the chat starts answering.',
    );
    expect(screen.queryByTestId('channels-connected-WEBCHAT')).toBeNull();
  });

  it('★★ website seen on the site: live, never claimed before', () => {
    show({ install: code('live') as never });
    expect(screen.getByTestId('channels-connected-WEBCHAT')).toHaveTextContent('Live on your site');
  });

  it('website with no code yet: the one press that makes it; unread is said', () => {
    const { unmount } = show({
      install: { code: null, shopify: [], woocommerce: { sites: [] } } as never,
    });
    expect(screen.getByTestId('get-the-code')).toBeInTheDocument();
    unmount();
    show({ install: null });
    expect(screen.getByTestId('channels-code-unread')).toBeInTheDocument();
  });

  it('★★ email: the same form, inline, without the Studio link; done re-reads the page', async () => {
    show();
    fireEvent.click(screen.getByTestId('channels-open-EMAIL'));
    const form = screen.getByTestId('email-form');
    expect(form).toHaveAttribute('data-note', 'false');
    // One way back only: the form's own.
    expect(screen.queryByTestId('channels-close-EMAIL')).toBeNull();
    await act(async () => fireEvent.click(form));
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('email-form')).toBeNull();
  });

  it('★★ WhatsApp: the wizard inline, coming back to THIS step', () => {
    show();
    fireEvent.click(screen.getByTestId('channels-open-WHATSAPP'));
    expect(screen.getByTestId('whatsapp-wizard')).toHaveAttribute(
      'data-close',
      '/onboarding/channels',
    );
    fireEvent.click(screen.getByTestId('channels-close-WHATSAPP'));
    expect(screen.queryByTestId('whatsapp-wizard')).toBeNull();
  });

  it('★ WhatsApp not set up on this platform: said in words, no wizard', () => {
    show({ config: config({ launches: { coexistence: null, newNumber: null } }) as never });
    fireEvent.click(screen.getByTestId('channels-open-WHATSAPP'));
    expect(screen.getByTestId('channels-whatsapp-unavailable')).toHaveTextContent(
      "This channel can't be connected from here yet.",
    );
    expect(screen.queryByTestId('whatsapp-wizard')).toBeNull();
  });

  it('★★ Instagram: to Meta and back; a refusal is said', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    actions.startChannelConnect.mockResolvedValueOnce({
      ok: true,
      url: 'https://meta.example/oauth',
    });
    show();
    fireEvent.click(screen.getByTestId('channels-open-INSTAGRAM'));
    await act(async () => fireEvent.click(screen.getByTestId('channels-instagram-go')));
    expect(actions.startChannelConnect).toHaveBeenCalledWith('INSTAGRAM');
    expect(assign).toHaveBeenCalledWith('https://meta.example/oauth');
    actions.startChannelConnect.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await act(async () => fireEvent.click(screen.getByTestId('channels-instagram-go')));
    expect(screen.getByTestId('channels-instagram-problem')).toHaveTextContent(
      "We couldn't open Meta.",
    );
    vi.unstubAllGlobals();
  });

  it('★ Instagram not set up: said, no button', () => {
    show({ config: config({ providers: { instagram: false } }) as never });
    fireEvent.click(screen.getByTestId('channels-open-INSTAGRAM'));
    expect(screen.getByTestId('channels-instagram-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('channels-instagram-go')).toBeNull();
  });

  it('★★ connected: said, and no way to connect it twice; a PENDING row is not connected', () => {
    show({ channels: [channel('WHATSAPP'), channel('INSTAGRAM', 'PENDING')] });
    expect(screen.getByTestId('channels-connected-WHATSAPP')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('channels-open-WHATSAPP')).toBeNull();
    expect(screen.getByTestId('channels-open-INSTAGRAM')).toBeInTheDocument();
  });

  it('★★ the way on: the QUIET "Continue without a channel" with its cost; primary Continue once one is connected or live', () => {
    const { unmount } = show({
      install: { code: null, shopify: [], woocommerce: { sites: [] } } as never,
    });
    const next = screen.getByTestId('channels-next');
    expect(next).toHaveTextContent('Continue without a channel');
    expect(next.className).toMatch(/secondary/);
    expect(next).toHaveAttribute('href', afterChannels(false));
    expect(screen.getByTestId('channels-skip-why')).toHaveTextContent("won't answer customers");
    unmount();
    show({
      channels: [channel('EMAIL')],
      install: { code: null, shopify: [], woocommerce: { sites: [] } } as never,
    });
    expect(screen.getByTestId('channels-next')).toHaveTextContent(/^Continue$/);
    expect(screen.getByTestId('channels-next').className).toMatch(/primary/);
  });

  it('★★ code that exists but was never SEEN is not connected: Continue stays quiet', () => {
    show();
    expect(screen.getByTestId('channels-code-ready-WEBCHAT')).toHaveTextContent(
      'Once you paste it into your site, the chat starts answering.',
    );
    expect(screen.getByTestId('channels-next')).toHaveTextContent('Continue without a channel');
    expect(screen.getByTestId('channels-next').className).toMatch(/secondary/);
  });

  it('★★ the code seen on the site is connected: primary Continue', () => {
    show({ install: code('live') as never });
    expect(screen.getByTestId('channels-next')).toHaveTextContent(/^Continue$/);
  });

  it('★★ the server’s snippet is shown VERBATIM, loader line included, and copied whole', () => {
    const real =
      '<script>window.__chatcenter = { widgetId: "w1", apiUrl: "https://app.gotcha.co.il" };</script>\n<script src="https://app.gotcha.co.il/widget/chatcenter-widget.js" async></script>';
    const install = code('not_seen');
    install.code.snippet = real;
    show({ install: install as never });
    expect(screen.getByTestId('channels-code-snippet').textContent).toBe(real);
    expect(screen.getByTestId('copy-code')).toHaveAttribute('data-code', real);
  });

  describe('★★ a Shopify shop: the theme toggle, above the code', () => {
    const shop = (over: object) => ({
      channelId: 'sh1',
      shopDomain: 'avivco.myshopify.com',
      status: 'active',
      embedLive: false,
      lastHeartbeatAt: null,
      themeEditorUrl: 'https://admin.shopify.com/store/avivco/themes/current/editor?context=apps',
      ...over,
    });
    const withShop = (over: object) => ({ ...code('not_seen'), shopify: [shop(over)] });

    it('★★ off in the theme: ONE action (the editor), the code under a quiet toggle, the line naming the theme', () => {
      show({ install: withShop({ status: 'not_enabled' }) as never });
      expect(screen.getByTestId('channels-shop-theme-sh1')).toHaveAttribute(
        'href',
        'https://admin.shopify.com/store/avivco/themes/current/editor?context=apps',
      );
      expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
      expect(screen.getByTestId('channels-shop-waiting-WEBCHAT')).toHaveTextContent(
        'Once you turn it on in the theme, it starts answering.',
      );
      expect(screen.queryByTestId('channels-code-ready-WEBCHAT')).toBeNull();
      fireEvent.click(screen.getByTestId('channels-show-code'));
      expect(screen.getByTestId('channels-code-snippet')).toBeInTheDocument();
      expect(screen.getByTestId('channels-next').className).toMatch(/secondary/);
    });

    it('★ live in the shop (enabled, embed seen): connected, no editor link', () => {
      show({ install: withShop({ status: 'active', embedLive: true }) as never });
      expect(screen.getByTestId('channels-shop-sh1')).toHaveTextContent(
        'The chat is live in your shop',
      );
      expect(screen.queryByTestId('channels-shop-theme-sh1')).toBeNull();
      expect(screen.getByTestId('channels-connected-WEBCHAT')).toBeInTheDocument();
      // Live: no waiting line, and the code is plain to see (no toggle).
      expect(screen.queryByTestId('channels-shop-waiting-WEBCHAT')).toBeNull();
      expect(screen.queryByTestId('channels-show-code')).toBeNull();
    });

    it('★ enabled but its theme embed never seen: NOT connected, the editor link stays', () => {
      show({ install: withShop({ status: 'active', embedLive: false }) as never });
      expect(screen.getByTestId('channels-shop-theme-sh1')).toBeInTheDocument();
      expect(screen.queryByTestId('channels-connected-WEBCHAT')).toBeNull();
      expect(screen.getByTestId('channels-next').className).toMatch(/secondary/);
    });

    it('an uninstalled shop is not offered', () => {
      show({ install: withShop({ status: 'uninstalled' }) as never });
      expect(screen.queryByTestId('channels-shop-sh1')).toBeNull();
    });
  });

  it('channels unread: said, never "none connected"', () => {
    show({ channels: null });
    expect(screen.getByTestId('channels-unread')).toBeInTheDocument();
  });

  it('★ preview: every connect is a status, never a control', () => {
    show({ preview: true });
    expect(screen.queryByTestId('channels-open-EMAIL')).toBeNull();
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
  });
});
