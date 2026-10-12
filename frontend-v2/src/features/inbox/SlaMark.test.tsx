import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { SLA_TICK_MS } from './sla-clock';
import { SlaMark } from './SlaMark';
import styles from './Inbox.module.css';

/**
 * W2: one row's mark, recomputed on a timer from the row's own times - the
 * list is not fetched again.
 */
const target = { since: '2026-10-12T10:00:00.000Z', minutes: 30, warningPercent: 70 };
const show = (renderedAt: string, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ inbox: locale === 'he' ? he : messages }}>
      <SlaMark target={target} renderedAt={renderedAt} testId="sla" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('★★ late: a red dot that pulses, and "Past SLA"', () => {
  it('drawn, with the target in its title', () => {
    vi.setSystemTime(new Date('2026-10-12T10:45:00.000Z'));
    show('2026-10-12T10:45:00.000Z');
    const mark = screen.getByTestId('sla');
    expect(mark).toHaveAttribute('data-sla', 'late');
    expect(mark).toHaveTextContent('Past SLA');
    expect(mark).toHaveAttribute('title', 'Waiting longer than the 30 min response target.');
    expect(mark.querySelector(`.${styles.slaDot}`)).not.toBeNull();
  });

  it('in Hebrew', () => {
    vi.setSystemTime(new Date('2026-10-12T10:45:00.000Z'));
    show('2026-10-12T10:45:00.000Z', 'he');
    expect(screen.getByTestId('sla')).toHaveTextContent('חריגה מה‑SLA');
  });

  it('★ the dot pulses, and is still under reduced motion', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/features/inbox/Inbox.module.css', 'utf8');
    expect(css).toMatch(/\.slaDot\s*\{[^}]*animation:\s*sla-pulse/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.slaDot\s*\{\s*animation:\s*none/,
    );
  });
});

describe('★★ close: quiet amber, the minutes left', () => {
  it('in both languages', () => {
    vi.setSystemTime(new Date('2026-10-12T10:25:00.000Z'));
    show('2026-10-12T10:25:00.000Z');
    expect(screen.getByTestId('sla')).toHaveAttribute('data-sla', 'warning');
    expect(screen.getByTestId('sla')).toHaveTextContent('5 min left');
  });

  it('Hebrew', () => {
    vi.setSystemTime(new Date('2026-10-12T10:25:00.000Z'));
    show('2026-10-12T10:25:00.000Z', 'he');
    expect(screen.getByTestId('sla')).toHaveTextContent('נותרו 5 דק׳');
  });
});

describe('★★ recomputed on its own clock, without a new list', () => {
  it('★★ nothing yet, then amber, then late - as time passes', () => {
    vi.setSystemTime(new Date('2026-10-12T10:15:00.000Z'));
    show('2026-10-12T10:15:00.000Z');
    expect(screen.queryByTestId('sla')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(7 * 60_000);
    });
    expect(screen.getByTestId('sla')).toHaveAttribute('data-sla', 'warning');
    act(() => {
      vi.advanceTimersByTime(9 * 60_000);
    });
    expect(screen.getByTestId('sla')).toHaveAttribute('data-sla', 'late');
  });

  it('★ the first paint is the server’s moment, then the device’s clock at once', () => {
    // A page rendered at 10:15 and opened at 10:40 - from the router's cache.
    vi.setSystemTime(new Date('2026-10-12T10:40:00.000Z'));
    show('2026-10-12T10:15:00.000Z');
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByTestId('sla')).toHaveAttribute('data-sla', 'late');
  });

  it('looks again every 30 seconds', () => {
    expect(SLA_TICK_MS).toBe(30_000);
  });
});
