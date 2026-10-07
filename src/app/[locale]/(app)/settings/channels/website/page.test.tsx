import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

const load = vi.hoisted(() => ({ loadWebsiteWidget: vi.fn() }));
vi.mock('@/features/webchat/load-website-widget', () => load);
const editor = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/features/webchat/WebchatSettings', () => ({
  WebchatSettings: (props: Record<string, unknown>) => {
    editor.props = props;
    return <div data-testid="editor" />;
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.webchat') =>
    createTranslator({ locale: 'en', messages: { channels }, namespace }),
}));
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('@/i18n/navigation', () => navigation);

import OldPage from '../webchat/[id]/page';
import Page from './page';

const SETTINGS = {
  appearance: { primaryColor: '#121212', logoUrl: null, language: 'auto', showPoweredBy: true },
  ux: {
    welcome: { assistantName: '', suggestedQuestions: [] },
    launcher: { position: 'right' },
    hero: { mediaType: 'none', mediaUrl: null },
    proactive: { enabled: false, trigger: 'time_on_page', delaySeconds: 15, message: '' },
  },
};

beforeEach(() => {
  load.loadWebsiteWidget.mockReset();
  navigation.redirect.mockReset();
  editor.props = null;
});

describe('★ 13g-13j at its one address - the workspace’s widget', () => {
  it('settings unread: says so, and no editor over a default widget', async () => {
    load.loadWebsiteWidget.mockResolvedValue({
      widget: null,
      install: null,
      shopifyData: null,
      shopifyAvailability: null,
      business: null,
    });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByTestId('webchat-unread')).toHaveTextContent(
      "Couldn't read the widget's settings",
    );
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('Shopify’s availability is read for Install only; the editor gets what was read', async () => {
    load.loadWebsiteWidget.mockResolvedValue({
      widget: {
        settings: SETTINGS,
        assignedEmployee: { id: 'a1', name: 'Maya' },
        places: { code: null, shopify: [] },
      },
      install: null,
      shopifyData: 'failing',
      shopifyAvailability: null,
      business: 'Aviv',
    });
    render(await Page({ searchParams: Promise.resolve({ tab: 'install' }) }));
    expect(load.loadWebsiteWidget).toHaveBeenCalledWith({ installTab: true });
    expect(editor.props).toMatchObject({
      tab: 'install',
      assigned: { name: 'Maya' },
      shopifyData: 'failing',
    });
    await Page({ searchParams: Promise.resolve({ tab: 'nonsense' }) });
    expect(load.loadWebsiteWidget).toHaveBeenLastCalledWith({ installTab: false });
  });

  it('★ the web chat’s old address opens the widget, on the tab it asked for', async () => {
    await OldPage({
      params: Promise.resolve({ locale: 'he', id: 'wc1' }),
      searchParams: Promise.resolve({ tab: 'install' }),
    });
    expect(navigation.redirect).toHaveBeenCalledWith({
      href: { pathname: '/settings/channels/website', query: { tab: 'install' } },
      locale: 'he',
    });
  });
});
