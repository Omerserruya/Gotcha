import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';
import { SupportProvider, type SupportView } from '@/support/support-context';

/** The banner on every page in support mode. Mocked: nothing is sent. */
const { endSupport, assign } = vi.hoisted(() => ({ endSupport: vi.fn(), assign: vi.fn() }));
vi.mock('./actions', () => ({ endSupport }));

import { SUPPORT_ENDED_EVENT } from '@/api/client/browser-api';

import { SupportBanner, WithSupportBanner } from './SupportBanner';

const SESSION: SupportView = { tenantName: 'Aviv & Co.', reason: 'ticket 42', endsAt: '16:40' };

const show = (session: SupportView | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ console: locale === 'en' ? consoleEn : consoleHe }}
    >
      <SupportProvider session={session}>
        <WithSupportBanner>
          <div data-testid="frame">the app</div>
        </WithSupportBanner>
      </SupportProvider>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  endSupport.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('★★ the support banner', () => {
  it('★★ whose workspace, why, until when, and Exit - with the page below it', () => {
    show(SESSION);
    expect(screen.getByTestId('support-banner-who')).toHaveTextContent(
      'You are working in Aviv & Co. as its admin. Everything you do here is recorded as GOTCHA Support.',
    );
    expect(screen.getByTestId('support-banner-who').querySelector('bdi')).toHaveTextContent(
      'Aviv & Co.',
    );
    expect(screen.getByTestId('support-banner-reason')).toHaveTextContent('Reason: ticket 42');
    expect(screen.getByTestId('support-banner-ends')).toHaveTextContent('Ends at 16:40');
    expect(screen.getByTestId('frame')).toBeInTheDocument();
  });

  it('★ never dismissible: Exit is its only control', () => {
    show(SESSION);
    expect(screen.getByTestId('support-banner').querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByTestId('support-exit')).toHaveTextContent('Exit support mode');
  });

  it('Hebrew: its own words', () => {
    show(SESSION, 'he');
    expect(screen.getByTestId('support-banner-who')).toHaveTextContent(
      'אתם עובדים בארגון Aviv & Co. כמנהלים שלו',
    );
    expect(screen.getByTestId('support-exit')).toHaveTextContent('יציאה ממצב תמיכה');
  });

  it('★ unread details: still the banner, saying support mode', () => {
    show({ tenantName: null, reason: null, endsAt: null });
    expect(screen.getByTestId('support-banner-who')).toHaveTextContent(
      "You are working in a customer's workspace as its admin.",
    );
    expect(screen.queryByTestId('support-banner-reason')).toBeNull();
    expect(screen.queryByTestId('support-banner-ends')).toBeNull();
  });

  it('outside support mode: nothing at all, the page as it was', () => {
    show(null);
    expect(screen.queryByTestId('support-banner')).toBeNull();
    expect(screen.getByTestId('frame').parentElement?.className ?? '').not.toMatch(/withBanner/);
  });

  it('★★ Exit ends it on the platform, then opens the console’s page for the workspace', async () => {
    endSupport.mockResolvedValue({ ok: true, tenantId: 't 9' });
    show(SESSION);
    await act(async () => fireEvent.click(screen.getByTestId('support-exit')));
    expect(endSupport).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/system/tenants/t%209');
  });

  it("★ Exit opens the console in the language the admin entered in, not the workspace's", async () => {
    endSupport.mockResolvedValue({ ok: true, tenantId: 't9', locale: 'en' });
    show(SESSION);
    await act(async () => fireEvent.click(screen.getByTestId('support-exit')));
    expect(assign).toHaveBeenCalledWith('/en/system/tenants/t9');
  });

  it('★★ an Exit that failed stays here and says so', async () => {
    endSupport.mockResolvedValue({ ok: false, reason: 'failed' });
    show(SESSION);
    await act(async () => fireEvent.click(screen.getByTestId('support-exit')));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByTestId('support-exit-failed')).toHaveTextContent(
      'Support mode could not be ended. Try again.',
    );
    expect(screen.getByTestId('support-exit')).toBeEnabled();
  });

  it('★★ the platform ended it mid-click: once, to the route that clears it', () => {
    show(SESSION);
    act(() => {
      window.dispatchEvent(new CustomEvent(SUPPORT_ENDED_EVENT));
      window.dispatchEvent(new CustomEvent(SUPPORT_ENDED_EVENT));
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/api/session/support-ended');
  });

  it('outside support mode the event moves nothing', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
        <SupportProvider session={null}>
          <SupportBanner />
        </SupportProvider>
      </NextIntlClientProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent(SUPPORT_ENDED_EVENT));
    });
    expect(assign).not.toHaveBeenCalled();
  });
});
