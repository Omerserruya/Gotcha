import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { WebOnly } from './web-only';

/** App Store 3.1.1: no purchase link inside the native app, and none in the first HTML. */
const inApp = (platform: 'ios' | 'android') => {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
};

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

const link = (
  <WebOnly fallback={<span>words only</span>}>
    <a href="/settings/billing">billing</a>
  </WebOnly>
);

describe('★★ a purchase link is drawn only where it is not the app', () => {
  it("★★ FAIL CLOSED: the server's HTML has no link - the app would show it before hydration", () => {
    const html = renderToString(link);
    expect(html).not.toContain('href');
    expect(html).toContain('words only');
  });

  it('★ a browser (no Capacitor): the link', () => {
    render(link);
    expect(screen.getByRole('link', { name: 'billing' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it.each(['ios', 'android'] as const)('★★ the %s app: the words, no link', (platform) => {
    inApp(platform);
    render(link);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('words only')).toBeInTheDocument();
  });

  it('★ a Capacitor that says it is not native (the web build) is a browser', () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => false };
    render(link);
    expect(screen.getByRole('link', { name: 'billing' })).toBeInTheDocument();
  });
});
