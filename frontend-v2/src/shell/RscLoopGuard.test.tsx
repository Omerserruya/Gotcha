import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import common from '@/i18n/messages/en/common.json';
import commonHe from '@/i18n/messages/he/common.json';

import { RSC_LOOP_LIMIT } from './rsc-loop-guard';
import { RscLoopGuard } from './RscLoopGuard';

/**
 * ★★ The shell's guard: it draws the shell until the tab asks for one page
 * in a loop, then only the notice. The browser's resource timing is played
 * here by a fake PerformanceObserver.
 */

let report: ((names: string[]) => void) | null = null;

class FakeObserver {
  constructor(private readonly callback: (list: { getEntries: () => { name: string }[] }) => void) {}
  observe() {
    report = (names) => this.callback({ getEntries: () => names.map((name) => ({ name })) });
  }
  disconnect() {
    report = null;
  }
}

const here = 'http://localhost';
const reload = vi.fn();
const realFetch = window.fetch;

beforeEach(() => {
  reload.mockClear();
  report = null;
  window.sessionStorage.clear();
  vi.stubGlobal('PerformanceObserver', FakeObserver);
  vi.stubGlobal('location', { href: `${here}/he/system`, origin: here, reload });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ common: locale === 'en' ? common : commonHe }}>
      <RscLoopGuard>
        <p data-testid="shell">the shell</p>
      </RscLoopGuard>
    </NextIntlClientProvider>,
  );

/** The router asking for one page `times` times, as the browser reports it. */
const loop = (times: number, path = '/he/system') =>
  act(async () => {
    for (let i = 0; i < times; i += 1) report?.([`${here}${path}?_rsc=t${i}`]);
  });

describe('★★ RscLoopGuard', () => {
  it('★★ a page asked for in a loop: the shell is unmounted, and the tab says so', async () => {
    show();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    // The mount's full load counted as one.
    await loop(RSC_LOOP_LIMIT - 1);
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    await loop(1);
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(screen.getByTestId('rsc-loop-notice')).toHaveTextContent(common.loopStopped.body);
  });

  it('★★ a loop that reloads the document: the load past the limit draws only the notice', () => {
    for (let load = 0; load < RSC_LOOP_LIMIT; load += 1) {
      const { unmount } = show();
      expect(screen.getByTestId('shell')).toBeInTheDocument();
      unmount();
    }
    show();
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(screen.getByTestId('rsc-loop-notice')).toBeInTheDocument();
  });

  it('★ other pages and plain requests never count against a page', async () => {
    show();
    for (let page = 0; page < 30; page += 1) await loop(3, `/he/system/tenants/${page}`);
    await act(async () => {
      report?.(Array.from({ length: 200 }, () => `${here}/api/bff/permissions/me`));
    });
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });

  it('★ Try again is one full load, pressed by a person', async () => {
    show();
    await loop(RSC_LOOP_LIMIT * 2);
    fireEvent.click(screen.getByTestId('rsc-loop-retry'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ it observes, never intercepts: window.fetch is untouched', () => {
    show();
    expect(window.fetch).toBe(realFetch);
  });

  it('Hebrew: the words, no English word and no dash', async () => {
    show('he');
    await loop(RSC_LOOP_LIMIT * 2);
    expect(screen.getByTestId('rsc-loop-notice')).toHaveTextContent(commonHe.loopStopped.body);
    for (const words of Object.values(commonHe.loopStopped)) {
      expect(words).not.toMatch(/[A-Za-z]/);
      for (const ch of words) expect([0x2013, 0x2014]).not.toContain(ch.codePointAt(0));
    }
  });
});

describe('★★ mounted around the shell, where the loop happens', () => {
  it.each(['src/app/[locale]/(app)/layout.tsx', 'src/app/[locale]/(mobile)/m/layout.tsx'])(
    '%s wraps its shell in it',
    (file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toMatch(/<RscLoopGuard>\s*<MfaWatch \/>\s*<(?:AppShell|MobileShell)\b[^]*?<\/RscLoopGuard>/);
    },
  );
});
