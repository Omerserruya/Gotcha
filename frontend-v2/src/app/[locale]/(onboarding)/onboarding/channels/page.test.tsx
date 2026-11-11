import { beforeEach, describe, expect, it, vi } from 'vitest';

/** /onboarding/channels: the way back from a provider is read here. Mocked: no reads. */
const { loads, pages } = vi.hoisted(() => ({
  loads: {
    loadChannelsStep: vi.fn(async () => ({ channels: [], install: null, config: {} })),
    loadInstallWays: vi.fn(async () => ({
      detected: 'woocommerce',
      shopify: { mode: 'listing', helpUrl: null },
    })),
  },
  pages: { loadMessengerPages: vi.fn(async () => ({ ok: true, pages: [] })) },
}));
vi.mock('@/features/onboarding/load-onboarding', () => loads);
vi.mock('@/features/channels/messenger-actions', () => pages);
vi.mock('@/features/onboarding/OnboardingShell', () => ({
  OnboardingShell: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/features/onboarding/ChannelsStep', () => ({ ChannelsStep: () => null }));
vi.mock('@/shell/page-metadata', () => ({ pageMetadata: () => () => ({}) }));

const { default: Page } = await import('./page');

/** The step's props, as the page hands them over. */
const props = async (query: Record<string, string>) => {
  const page = (await Page({ searchParams: Promise.resolve(query) })) as {
    props: { children: { props: Record<string, unknown> } };
  };
  return page.props.children.props;
};

beforeEach(() => {
  pages.loadMessengerPages.mockClear();
  loads.loadInstallWays.mockClear();
});

describe("★★ the website row: the platform the read found, and Shopify's availability", () => {
  it('★ handed to the step as read', async () => {
    const got = await props({});
    expect(loads.loadInstallWays).toHaveBeenCalledTimes(1);
    expect(got.detected).toBe('woocommerce');
    expect(got.shopify).toEqual({ mode: 'listing', helpUrl: null });
  });

  it('★ a preview opens no panel: nothing read for it', async () => {
    const got = await props({ preview: '1' });
    expect(loads.loadInstallWays).not.toHaveBeenCalled();
    expect(got.detected).toBeNull();
    expect(got.shopify).toBeNull();
  });
});

describe('★★ the way back lands on the step, read as 13 reads it', () => {
  it('★ connected=&count=', async () => {
    expect((await props({ connected: 'instagram', count: '1' })).landing).toEqual({
      channel: 'INSTAGRAM',
      outcome: 'connected',
      count: 1,
      pending: false,
      reason: null,
    });
  });

  it('★ pending=1&platform=&reason=SUBSCRIBE_FAILED', async () => {
    expect(
      (
        await props({
          connected: 'messenger',
          count: '1',
          pending: '1',
          platform: 'messenger',
          reason: 'SUBSCRIBE_FAILED',
        })
      ).landing,
    ).toMatchObject({ channel: 'MESSENGER', pending: true, reason: 'subscribe_failed' });
  });

  it('★ platform=&error=', async () => {
    expect((await props({ platform: 'gmail', error: 'gmail_no_email' })).landing).toEqual({
      channel: 'GMAIL',
      outcome: 'gmail_no_email',
    });
  });

  it('★★ pick=1&platform=messenger&session=: its Pages are read, for the picker', async () => {
    const got = await props({ pick: '1', platform: 'messenger', session: 's-1' });
    expect(pages.loadMessengerPages).toHaveBeenCalledWith('s-1');
    expect(got.pick).toEqual({ session: 's-1', read: { ok: true, pages: [] } });
    expect(got.landing).toBeNull();
  });

  it('nothing on the URL: nothing said, nothing read', async () => {
    const got = await props({});
    expect(got.landing).toBeNull();
    expect(got.pick).toBeNull();
    expect(pages.loadMessengerPages).not.toHaveBeenCalled();
  });

  it('★ a preview reads no way back', async () => {
    const got = await props({
      preview: '1',
      connected: 'instagram',
      pick: '1',
      platform: 'messenger',
      session: 's',
    });
    expect(got.landing).toBeNull();
    expect(got.pick).toBeNull();
    expect(got.preview).toBe(true);
  });
});
