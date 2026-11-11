import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import { channelLandingOf } from '@/features/channels/landing';
import channelsEn from '@/i18n/messages/en/channels.json';
import onboardingEn from '@/i18n/messages/en/onboarding.json';

/** Step 3. Mocked: nothing connects, no number, page or mailbox is touched. */
const { actions, messenger, router } = vi.hoisted(() => ({
  actions: { startChannelConnect: vi.fn() },
  messenger: { selectMessengerPages: vi.fn() },
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));
vi.mock('@/features/channels/actions', () => actions);
vi.mock('@/features/channels/messenger-actions', () => messenger);
vi.mock('@/features/channels/ConnectWhatsApp', () => ({
  ConnectWhatsApp: ({
    closeHref,
    onCancel,
    onDone,
  }: {
    closeHref: string;
    onCancel?: () => void;
    onDone?: () => void;
  }) => (
    <div data-testid="whatsapp-wizard" data-close={closeHref}>
      <button type="button" data-testid="wizard-cancel" onClick={onCancel} />
      <button type="button" data-testid="wizard-done" onClick={onDone} />
    </div>
  ),
}));
vi.mock('@/features/channels/ConnectPanel', () => ({
  EmailStep: ({ note, onClose }: { note?: boolean; onClose: () => void }) => (
    <button type="button" data-testid="email-form" data-note={String(note)} onClick={onClose} />
  ),
}));
vi.mock('@/features/capabilities/ShopifyConnect', () => ({
  ShopifyConnect: (props: {
    mode: string | null;
    connectAllowed: boolean | null;
    flow: string;
  }) => (
    <span
      data-testid="shopify-connect"
      data-mode={String(props.mode)}
      data-allowed={String(props.connectAllowed)}
      data-flow={props.flow}
    />
  ),
}));
vi.mock('@/features/webchat/WooPlugin', () => ({
  WooPlugin: ({ woo }: { woo: { sites: readonly unknown[] } }) => (
    <span data-testid="woo-plugin" data-sites={woo.sites.length} />
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
  providers: { instagram: true, messenger: true, gmail: true, outlook: true },
  ...over,
});
const code = (status: 'live' | 'not_seen') => ({
  code: {
    widgetId: 'w1',
    snippet: '<script>chat</script>',
    status,
    firstSeenAt: null,
    lastSeenAt: null,
    lastHost: status === 'live' ? 'avivco.il' : null,
  },
  shopify: [],
  woocommerce: { sites: [] },
});
const noCode = { code: null, shopify: [], woocommerce: { sites: [] } };
type Props = Parameters<typeof ChannelsStep>[0];
const tree = (props: Partial<Props> = {}) => (
  <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingEn, channels: channelsEn }}>
    <ChannelsStep
      channels={[]}
      install={code('not_seen') as never}
      config={config() as never}
      {...props}
    />
  </NextIntlClientProvider>
);
const show = (props: Partial<Props> = {}) => render(tree(props));
const channel = (type: string, status = 'CONNECTED', over: object = {}) =>
  channelSchema.parse({ id: `c-${type}`, channel: type, connectionStatus: status, ...over });
const row = (name: string) => screen.getByTestId(`channels-${name}`);
/** A way back, read the way the page reads it. */
const back = (query: Record<string, string>) => channelLandingOf(query);

const assign = vi.fn();
beforeEach(() => {
  actions.startChannelConnect.mockReset();
  messenger.selectMessengerPages.mockReset();
  router.refresh.mockClear();
  router.replace.mockClear();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

describe('★★ step 3: one list, one row per channel', () => {
  it('★ the five channels, in order, each with its line, where it stands and ONE action', () => {
    show({ install: noCode as never });
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((li) => li.getAttribute('data-testid'))).toEqual([
      'channels-WEBCHAT',
      'channels-WHATSAPP',
      'channels-INSTAGRAM',
      'channels-MESSENGER',
      'channels-EMAIL',
    ]);
    expect(row('WEBCHAT')).toHaveTextContent('Paste the code once.');
    expect(row('MESSENGER')).toHaveTextContent("Messages to your business's Facebook Page");
    for (const li of rows) {
      expect(within(li).getAllByRole('button')).toHaveLength(1);
      expect(li).toHaveAttribute('data-state', 'none');
    }
    expect(screen.getByTestId('channels-status-WHATSAPP')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('channels-open-WEBCHAT')).toHaveTextContent('Install');
    expect(screen.getByTestId('channels-open-INSTAGRAM')).toHaveTextContent(/^Connect$/);
  });

  it('★★ connected looks done: the identifier, no action; the website "live" with its host', () => {
    show({
      channels: [
        channel('WHATSAPP', 'CONNECTED', { displayName: '+972 50-123-4567' }),
        channel('GMAIL', 'CONNECTED', { externalId: 'hi@avivco.il' }),
      ],
      install: code('live') as never,
    });
    expect(screen.getByTestId('channels-connected-WHATSAPP')).toHaveTextContent('Connected');
    expect(screen.getByTestId('channels-identity-WHATSAPP')).toHaveTextContent('+972 50-123-4567');
    expect(screen.queryByTestId('channels-open-WHATSAPP')).toBeNull();
    // Gmail is the email row's.
    expect(row('EMAIL')).toHaveAttribute('data-state', 'connected');
    expect(screen.getByTestId('channels-identity-EMAIL')).toHaveTextContent('hi@avivco.il');
    expect(screen.getByTestId('channels-connected-WEBCHAT')).toHaveTextContent('Live on your site');
    expect(screen.getByTestId('channels-identity-WEBCHAT')).toHaveTextContent('avivco.il');
    expect(screen.queryByTestId('channels-open-WEBCHAT')).toBeNull();
  });

  it('★★ needs attention: an account in ERROR or not finished; its action connects again', () => {
    show({ channels: [channel('INSTAGRAM', 'PENDING'), channel('OUTLOOK', 'ERROR')] });
    expect(row('INSTAGRAM')).toHaveAttribute('data-state', 'attention');
    expect(screen.getByTestId('channels-status-INSTAGRAM')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('channels-open-INSTAGRAM')).toHaveTextContent('Connect again');
    expect(screen.getByTestId('channels-attention-INSTAGRAM')).toBeInTheDocument();
    expect(row('EMAIL')).toHaveAttribute('data-state', 'attention');
    // Neither answers: Continue stays quiet.
    expect(screen.getByTestId('channels-next')).toHaveTextContent('Continue without a channel');
  });
});

describe('★★ each channel connects from its row', () => {
  it('★★ website: Install opens the code HERE, copied whole; "ready, not seen" until seen', () => {
    show();
    expect(screen.getByTestId('channels-code-ready-WEBCHAT')).toHaveTextContent(
      'The code is ready. Once you paste it into your site, the chat starts answering.',
    );
    expect(screen.getByTestId('channels-status-WEBCHAT')).toHaveTextContent('Not live yet');
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-code-snippet')).toHaveTextContent('<script>chat</script>');
    expect(screen.getByTestId('copy-code')).toHaveAttribute('data-code', '<script>chat</script>');
    // The same action closes it.
    expect(screen.getByTestId('channels-open-WEBCHAT')).toHaveTextContent('Close');
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
  });

  it('website with no code yet: the one press that makes it; unread is said', () => {
    const { unmount } = show({ install: noCode as never });
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('get-the-code')).toBeInTheDocument();
    unmount();
    show({ install: null });
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-code-unread')).toBeInTheDocument();
  });

  it('★★ the server’s snippet is shown VERBATIM, loader line included, and copied whole', () => {
    const real =
      '<script>window.__chatcenter = { widgetId: "w1", apiUrl: "https://app.gotcha.co.il" };</script>\n<script src="https://app.gotcha.co.il/widget/chatcenter-widget.js" async></script>';
    const install = code('not_seen');
    install.code.snippet = real;
    show({ install: install as never });
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-code-snippet').textContent).toBe(real);
    expect(screen.getByTestId('copy-code')).toHaveAttribute('data-code', real);
  });

  it('★★ WhatsApp: the wizard inline; its Cancel and its last Continue both close HERE and re-read', async () => {
    show();
    fireEvent.click(screen.getByTestId('channels-open-WHATSAPP'));
    expect(screen.getByTestId('whatsapp-wizard')).toHaveAttribute(
      'data-close',
      '/onboarding/channels',
    );
    await act(async () => fireEvent.click(screen.getByTestId('wizard-done')));
    expect(screen.queryByTestId('whatsapp-wizard')).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('channels-open-WHATSAPP'));
    await act(async () => fireEvent.click(screen.getByTestId('wizard-cancel')));
    expect(screen.queryByTestId('whatsapp-wizard')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('★ WhatsApp not set up on this platform: said in words, no action', () => {
    show({ config: config({ launches: { coexistence: null, newNumber: null } }) as never });
    expect(screen.queryByTestId('channels-open-WHATSAPP')).toBeNull();
    expect(screen.getByTestId('channels-unavailable-WHATSAPP')).toHaveTextContent(
      "This channel can't be connected from here yet.",
    );
  });

  it.each(['INSTAGRAM', 'MESSENGER'] as const)(
    '★★ %s: the row’s action goes to Meta, coming back to THIS step; a refusal is said on the row',
    async (name) => {
      actions.startChannelConnect.mockResolvedValueOnce({
        ok: true,
        url: 'https://meta.example/o',
      });
      show();
      await act(async () => fireEvent.click(screen.getByTestId(`channels-open-${name}`)));
      expect(actions.startChannelConnect).toHaveBeenCalledWith(name, 'onboarding_channels');
      expect(assign).toHaveBeenCalledWith('https://meta.example/o');
      actions.startChannelConnect.mockResolvedValueOnce({ ok: false, reason: 'failed' });
      await act(async () => fireEvent.click(screen.getByTestId(`channels-open-${name}`)));
      expect(screen.getByTestId(`channels-problem-${name}`)).toHaveTextContent(
        "We couldn't open Meta.",
      );
    },
  );

  it('★ Instagram not set up: said, no action', () => {
    show({ config: config({ providers: { instagram: false } }) as never });
    expect(screen.queryByTestId('channels-open-INSTAGRAM')).toBeNull();
    expect(screen.getByTestId('channels-unavailable-INSTAGRAM')).toBeInTheDocument();
  });

  it('★★ email: Gmail and Outlook at the provider (back HERE); another server inline, without the Studio link', async () => {
    actions.startChannelConnect.mockResolvedValueOnce({
      ok: true,
      url: 'https://google.example/o',
    });
    show();
    fireEvent.click(screen.getByTestId('channels-open-EMAIL'));
    await act(async () => fireEvent.click(screen.getByTestId('channels-email-GMAIL')));
    expect(actions.startChannelConnect).toHaveBeenCalledWith('GMAIL', 'onboarding_channels');
    expect(assign).toHaveBeenCalledWith('https://google.example/o');
    actions.startChannelConnect.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    await act(async () => fireEvent.click(screen.getByTestId('channels-email-OUTLOOK')));
    expect(screen.getByTestId('channels-problem-email')).toHaveTextContent(
      "We couldn't open Outlook.",
    );
    fireEvent.click(screen.getByTestId('channels-email-server'));
    const form = screen.getByTestId('email-form');
    expect(form).toHaveAttribute('data-note', 'false');
    await act(async () => fireEvent.click(form));
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('email-form')).toBeNull();
  });

  it('email: a provider not set up is not offered', () => {
    show({ config: config({ providers: { gmail: false } }) as never });
    fireEvent.click(screen.getByTestId('channels-open-EMAIL'));
    expect(screen.queryByTestId('channels-email-GMAIL')).toBeNull();
    expect(screen.getByTestId('channels-email-OUTLOOK')).toBeInTheDocument();
  });
});

describe('★★ back from the provider: on its own row, then the URL is tidied', () => {
  it('★★ connected=&count=: said on that row, and it holds after the URL is tidied', () => {
    const { rerender } = show({
      channels: [channel('INSTAGRAM', 'CONNECTED', { displayName: '@avivco' })],
      landing: back({ connected: 'instagram', count: '1' }),
    });
    const said = screen.getByTestId('channels-landing-INSTAGRAM');
    expect(said).toHaveTextContent('One account connected.');
    expect(said).toHaveAttribute('data-outcome', 'ok');
    expect(row('INSTAGRAM')).toHaveAttribute('data-state', 'connected');
    expect(router.replace).toHaveBeenCalledWith('/onboarding/channels', { scroll: false });
    // The tidied URL renders with no landing: the sentence stays.
    rerender(tree({ channels: [channel('INSTAGRAM', 'CONNECTED', { displayName: '@avivco' })] }));
    expect(screen.getByTestId('channels-landing-INSTAGRAM')).toBeInTheDocument();
    expect(screen.getByTestId('channels-next')).toHaveTextContent(/^Continue$/);
  });

  it('★ connected=gmail: the email row says it', () => {
    show({ landing: back({ connected: 'gmail', count: '1' }) });
    expect(screen.getByTestId('channels-landing-EMAIL')).toHaveTextContent('One account connected');
  });

  it('★★ pending=1&reason=SUBSCRIBE_FAILED: connected but deaf, so the row needs attention', () => {
    show({
      channels: [channel('MESSENGER', 'CONNECTED', { displayName: 'Aviv & Co.' })],
      landing: back({
        connected: 'messenger',
        count: '1',
        pending: '1',
        platform: 'messenger',
        reason: 'SUBSCRIBE_FAILED',
      }),
    });
    expect(row('MESSENGER')).toHaveAttribute('data-state', 'attention');
    expect(screen.getByTestId('channels-landing-MESSENGER')).toHaveTextContent(
      "messages aren't arriving",
    );
    expect(screen.getByTestId('channels-landing-MESSENGER')).toHaveAttribute(
      'data-outcome',
      'problem',
    );
    expect(screen.getByTestId('channels-open-MESSENGER')).toHaveTextContent('Connect again');
  });

  it('★ pending=1 with no known reason, on WhatsApp: its own sentence', () => {
    show({ landing: back({ connected: 'whatsapp', pending: '1' }) });
    expect(screen.getByTestId('channels-landing-WHATSAPP')).toHaveTextContent(
      "Meta's approval isn't finished yet",
    );
  });

  it('★★ platform=&error=: the refusal in words on that row; its action tries again', () => {
    show({ landing: back({ platform: 'instagram', error: 'no_instagram_account' }) });
    const said = screen.getByTestId('channels-landing-INSTAGRAM');
    expect(said).toHaveTextContent('No Instagram business account is linked to that Page.');
    expect(said).toHaveAttribute('data-outcome', 'problem');
    expect(screen.getByTestId('channels-open-INSTAGRAM')).toBeInTheDocument();
    expect(router.replace).toHaveBeenCalledWith('/onboarding/channels', { scroll: false });
  });

  it('★ an unknown code is "didn’t connect", never the raw text; v1’s with no platform is said over the list', () => {
    const { unmount } = show({
      landing: back({ platform: 'outlook', error: 'AADSTS50020: weird' }),
    });
    expect(screen.getByTestId('channels-landing-EMAIL')).toHaveTextContent(
      "That didn't connect. You can try again.",
    );
    expect(screen.getByTestId('channels-landing-EMAIL')).not.toHaveTextContent('AADSTS');
    unmount();
    show({ landing: back({ error: 'access_denied' }) });
    expect(screen.getByTestId('channels-landing')).toHaveTextContent('You cancelled');
  });

  it('★★ pick=1&platform=messenger&session=: the Page picker on Messenger’s row; the URL tidied to this step', async () => {
    messenger.selectMessengerPages.mockResolvedValue({
      ok: true,
      results: [{ id: 'p1', name: 'Shop', status: 'connected', subscribed: true }],
    });
    show({
      pick: {
        session: 's1',
        read: {
          ok: true,
          pages: [
            { id: 'p1', name: 'Shop', category: null, connectedHere: false, takenElsewhere: false },
          ],
        },
      },
    });
    const picker = within(row('MESSENGER')).getByTestId('messenger-pick');
    expect(picker).toHaveTextContent('Shop');
    expect(router.replace).toHaveBeenCalledWith('/onboarding/channels', { scroll: false });
    fireEvent.click(screen.getByTestId('messenger-pick-p1'));
    await act(async () => fireEvent.click(screen.getByTestId('messenger-pick-confirm')));
    expect(messenger.selectMessengerPages).toHaveBeenCalledWith('s1', ['p1']);
    expect(router.refresh).toHaveBeenCalled();
  });

  it('★ an expired pick connects Messenger again, coming back to THIS step', async () => {
    actions.startChannelConnect.mockResolvedValue({ ok: true, url: 'https://meta.example/o' });
    show({ pick: { session: 's1', read: { ok: false, reason: 'expired' } } });
    await act(async () => fireEvent.click(screen.getByTestId('messenger-pick-again')));
    expect(actions.startChannelConnect).toHaveBeenCalledWith('MESSENGER', 'onboarding_channels');
  });

  it('no way back: the URL is left alone', () => {
    show();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('★★ the way on', () => {
  it('★★ "Continue without a channel" is QUIET, with its cost; primary Continue once one answers', () => {
    const { unmount } = show({ install: noCode as never });
    const next = screen.getByTestId('channels-next');
    expect(next).toHaveTextContent('Continue without a channel');
    expect(next.className).toMatch(/channelSkip/);
    expect(next.className).not.toMatch(/primary/);
    expect(next).toHaveAttribute('href', afterChannels(false));
    expect(screen.getByTestId('channels-skip-why')).toHaveTextContent("won't answer customers");
    unmount();
    show({ channels: [channel('EMAIL')], install: noCode as never });
    expect(screen.getByTestId('channels-next')).toHaveTextContent(/^Continue$/);
    expect(screen.getByTestId('channels-next').className).toMatch(/primary/);
    expect(screen.queryByTestId('channels-skip-why')).toBeNull();
  });

  it('★★ code that exists but was never SEEN is not connected: Continue stays quiet', () => {
    show();
    expect(screen.getByTestId('channels-next')).toHaveTextContent('Continue without a channel');
  });

  it('★★ the code seen on the site is connected: primary Continue', () => {
    show({ install: code('live') as never });
    expect(screen.getByTestId('channels-next')).toHaveTextContent(/^Continue$/);
  });
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
    expect(screen.getByTestId('channels-shop-waiting-WEBCHAT')).toHaveTextContent(
      'Once you turn it on in the theme, it starts answering.',
    );
    expect(screen.queryByTestId('channels-code-ready-WEBCHAT')).toBeNull();
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-shop-theme-sh1')).toHaveAttribute(
      'href',
      'https://admin.shopify.com/store/avivco/themes/current/editor?context=apps',
    );
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
    expect(screen.getByTestId('channels-other-ways')).toHaveTextContent(
      'Not on Shopify? Choose another way',
    );
    fireEvent.click(screen.getByTestId('channels-other-ways'));
    expect(screen.getByTestId('channels-code-snippet')).toBeInTheDocument();
    expect(screen.getByTestId('channels-next').className).toMatch(/channelSkip/);
  });

  it('★ live in the shop (enabled, embed seen): connected, named by the shop, no action', () => {
    show({ install: withShop({ status: 'active', embedLive: true }) as never });
    expect(screen.getByTestId('channels-connected-WEBCHAT')).toBeInTheDocument();
    expect(screen.getByTestId('channels-identity-WEBCHAT')).toHaveTextContent(
      'avivco.myshopify.com',
    );
    expect(screen.queryByTestId('channels-open-WEBCHAT')).toBeNull();
    expect(screen.queryByTestId('channels-shop-waiting-WEBCHAT')).toBeNull();
  });

  it('★ enabled but its theme embed never seen: NOT connected, the editor link stays', () => {
    show({ install: withShop({ status: 'active', embedLive: false }) as never });
    expect(screen.queryByTestId('channels-connected-WEBCHAT')).toBeNull();
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-shop-theme-sh1')).toBeInTheDocument();
  });

  it('an uninstalled shop is not offered', () => {
    show({ install: withShop({ status: 'uninstalled' }) as never });
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.queryByTestId('channels-shop-sh1')).toBeNull();
  });
});

describe('★★ the website: the way that fits the site first, the other two one press away', () => {
  const availability = { mode: 'listing', helpUrl: null, connectAllowed: true };
  const open = (props: Partial<Props>) => {
    show(props);
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    return screen.getByTestId('channels-website');
  };
  const ways = () =>
    Array.from(document.querySelectorAll('[data-testid^="channels-way-"]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id !== 'channels-way-found');

  it('★★ Shopify found: Connect Shopify first, back to step 2 to claim the store; nothing else yet', () => {
    const panel = open({ detected: 'shopify', shopify: availability as never });
    expect(panel).toHaveAttribute('data-way', 'shopify');
    expect(screen.getByTestId('channels-way-found')).toHaveTextContent(
      'We found Shopify on your site, so this is the quickest way.',
    );
    expect(ways()).toEqual(['channels-way-shopify']);
    const connect = screen.getByTestId('shopify-connect');
    expect(connect).toHaveAttribute('data-flow', 'onboarding_systems');
    expect(connect).toHaveAttribute('data-mode', 'listing');
    expect(connect).toHaveAttribute('data-allowed', 'true');
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
    expect(screen.getByTestId('channels-other-ways')).toHaveTextContent(
      'Not on Shopify? Choose another way',
    );
  });

  it('★★ the other two, in 13j order, after one press; the press goes away', () => {
    open({ detected: 'shopify', shopify: availability as never });
    fireEvent.click(screen.getByTestId('channels-other-ways'));
    expect(ways()).toEqual([
      'channels-way-shopify',
      'channels-way-woocommerce',
      'channels-way-code',
    ]);
    expect(screen.getByTestId('copy-code')).toHaveAttribute('data-code', '<script>chat</script>');
    expect(screen.queryByTestId('channels-other-ways')).toBeNull();
  });

  it('★★ WooCommerce found: the plugin first (its sites with it), then Shopify and the code', () => {
    const panel = open({ detected: 'woocommerce' });
    expect(panel).toHaveAttribute('data-way', 'woocommerce');
    expect(screen.getByTestId('channels-way-found')).toHaveTextContent(
      'We found WooCommerce on your site',
    );
    expect(ways()).toEqual(['channels-way-woocommerce']);
    expect(screen.getByTestId('woo-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('channels-other-ways')).toHaveTextContent(
      'Not on WooCommerce? Choose another way',
    );
    fireEvent.click(screen.getByTestId('channels-other-ways'));
    expect(ways()).toEqual([
      'channels-way-woocommerce',
      'channels-way-shopify',
      'channels-way-code',
    ]);
    // Shopify's availability unread: the connect is told so, never guessed.
    expect(screen.getByTestId('shopify-connect')).toHaveAttribute('data-mode', 'null');
  });

  it.each([null, 'wix', 'squarespace', 'webflow', 'magento'])(
    '★★ found %s: the code first, no "we found" line, the store ways one press away',
    (detected) => {
      const panel = open({ detected });
      expect(panel).toHaveAttribute('data-way', 'code');
      expect(screen.queryByTestId('channels-way-found')).toBeNull();
      expect(ways()).toEqual(['channels-way-code']);
      expect(screen.getByTestId('channels-code-snippet')).toHaveTextContent(
        '<script>chat</script>',
      );
      expect(screen.getByTestId('channels-way-code')).toHaveTextContent(
        'before the closing body tag',
      );
      expect(screen.getByTestId('channels-other-ways')).toHaveTextContent(
        'Is your site on Shopify or WooCommerce? Choose another way',
      );
    },
  );

  it('★ the slug is read as the read writes it, any case', () => {
    open({ detected: ' Shopify ' });
    expect(screen.getByTestId('channels-website')).toHaveAttribute('data-way', 'shopify');
  });

  it('★★ where the chat already is outranks the read: a shop first, with no "we found" line', () => {
    const install = {
      ...code('not_seen'),
      shopify: [
        {
          channelId: 'sh1',
          shopDomain: 'avivco.myshopify.com',
          status: 'not_enabled',
          embedLive: false,
          lastHeartbeatAt: null,
          themeEditorUrl: 'https://admin.shopify.com/x',
        },
      ],
    };
    open({ install: install as never, detected: 'woocommerce' });
    expect(screen.getByTestId('channels-website')).toHaveAttribute('data-way', 'shopify');
    expect(screen.queryByTestId('channels-way-found')).toBeNull();
    expect(screen.getByTestId('channels-shop-theme-sh1')).toBeInTheDocument();
    expect(screen.queryByTestId('shopify-connect')).toBeNull();
  });

  it('★ a plugin site that connected outranks the read too', () => {
    const install = {
      ...code('not_seen'),
      woocommerce: {
        sites: [{ id: 'w1', siteUrl: 'https://a.co.il', status: 'connected', lastSeenAt: null }],
      },
    };
    open({ install: install as never, detected: 'shopify' });
    expect(screen.getByTestId('channels-website')).toHaveAttribute('data-way', 'woocommerce');
    expect(screen.getByTestId('woo-plugin')).toHaveAttribute('data-sites', '1');
  });

  it('★★ offering a way claims nothing: not live, Continue stays quiet, until the code is SEEN', () => {
    open({ detected: 'woocommerce' });
    fireEvent.click(screen.getByTestId('channels-other-ways'));
    expect(screen.getByTestId('channels-status-WEBCHAT')).toHaveTextContent('Not live yet');
    expect(screen.queryByTestId('channels-connected-WEBCHAT')).toBeNull();
    expect(screen.getByTestId('channels-next')).toHaveTextContent('Continue without a channel');
  });
});

describe('reads and preview', () => {
  it('channels unread: said, never "none connected"', () => {
    show({ channels: null });
    expect(screen.getByTestId('channels-unread')).toBeInTheDocument();
  });

  it('★ preview: every connect is a status, never a control; no picker', () => {
    show({ preview: true });
    expect(screen.queryByTestId('channels-open-EMAIL')).toBeNull();
    expect(screen.queryByTestId('channels-open-INSTAGRAM')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('channels-code-snippet')).toBeNull();
  });

  it('★ Hebrew: every row’s words are in the catalogue (no raw key)', async () => {
    const he = (await import('@/i18n/messages/he/onboarding.json')).default;
    const heChannels = (await import('@/i18n/messages/he/channels.json')).default;
    render(
      <NextIntlClientProvider locale="he" messages={{ onboarding: he, channels: heChannels }}>
        <ChannelsStep
          channels={[channel('INSTAGRAM', 'ERROR')]}
          install={code('not_seen') as never}
          config={config() as never}
          landing={back({ connected: 'messenger', count: '2' })}
          detected="shopify"
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByTestId('channels-open-WEBCHAT'));
    expect(screen.getByTestId('channels-way-found')).toHaveTextContent('מצאנו Shopify באתר שלכם');
    expect(screen.getByTestId('channels-way-shopify')).toHaveTextContent('חנות ה\u2011Shopify');
    expect(screen.getByTestId('channels-other-ways')).toHaveTextContent('לא ב\u2011Shopify?');
    fireEvent.click(screen.getByTestId('channels-other-ways'));
    expect(document.body.textContent).not.toMatch(/onboarding\.channels|channels\.\w+\./);
    expect(screen.getByTestId('channels-landing-MESSENGER')).toHaveTextContent('2 חשבונות חוברו');
  });
});
