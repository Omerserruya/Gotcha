import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverySchema, scannedFacts, type Discovery } from '@/api/contracts/onboarding';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ readReading: vi.fn(), startReading: vi.fn() }));
vi.mock('./onboarding-actions', () => actions);

import type { ReadingRead } from './load-onboarding';
import { POLL_MS, ReadingStep, START_WAIT_MS, readingPhase } from './ReadingStep';

const SINCE = '2026-10-06T10:00:00.000Z';
const row = (over: Record<string, unknown> = {}): Discovery =>
  discoverySchema.parse({
    websiteDomain: 'https://avivco.il',
    status: 'SCANNING',
    scanPhase: 'pages',
    updatedAt: '2026-10-06T10:00:05.000Z',
    ...over,
  });

const show = (initial: ReadingRead | null, since: string | null = SINCE) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <ReadingStep initial={initial} since={since} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  actions.readReading.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('★ where the read is', () => {
  it('a row from before this visit is the LAST read - this one is still starting', () => {
    expect(
      readingPhase(row({ status: 'COMPLETE', updatedAt: '2026-10-05T09:00:00Z' }), SINCE),
    ).toBe('starting');
    expect(readingPhase(row(), SINCE)).toBe('reading');
    expect(readingPhase(row({ status: 'COMPLETE' }), SINCE)).toBe('done');
    expect(readingPhase(row({ status: 'FAILED' }), SINCE)).toBe('failed');
    expect(readingPhase(null, SINCE)).toBe('starting');
  });

  it('facts: only what a website read wrote, with its page, newest first', () => {
    const facts = scannedFacts([
      {
        id: 'a',
        title: 'Free delivery over 350',
        status: 'ready',
        sourceType: 'onboarding_scan',
        sourceUrl: 'https://avivco.il/shipping/',
        updatedAt: '2026-10-06T10:01:00Z',
      },
      {
        id: 'b',
        title: 'A note',
        status: 'ready',
        sourceType: 'text',
        sourceUrl: null,
        updatedAt: '2026-10-06T10:02:00Z',
      },
      {
        id: 'c',
        title: 'Exchanges within 30 days',
        status: 'pending',
        sourceType: 'url',
        sourceUrl: 'https://avivco.il/faq',
        updatedAt: '2026-10-06T10:03:00Z',
      },
    ]);
    expect(facts.map((f) => [f.id, f.path])).toEqual([
      ['c', '/faq'],
      ['a', '/shipping'],
    ]);
  });
});

describe('★★ 00e - visible the whole time, never an invented count', () => {
  it('reading: pages counted when the route has counted them; the other four say they are not', () => {
    show({
      discovery: row({ crawl: { requested: 220, pagesRead: 142, distinctTextPages: 140 } }),
      facts: [],
    });
    expect(screen.getByTestId('reading-track-pages')).toHaveTextContent('142');
    expect(screen.getByTestId('reading-track-pages')).toHaveTextContent('of 220');
    for (const track of ['products', 'policies', 'places', 'voice']) {
      expect(screen.getByTestId(`reading-track-${track}`)).toHaveTextContent(
        'Not counted separately yet',
      );
      expect(screen.getByTestId(`reading-track-${track}`).textContent).not.toMatch(/\d/);
    }
    expect(screen.getByTestId('reading-progress')).toHaveAttribute('aria-valuenow', '45');
  });

  it('looks again until it settles, then stops', async () => {
    actions.readReading.mockResolvedValue({
      discovery: row({ status: 'COMPLETE', scanPhase: 'done', gaps: [{ label: 'Gift wrapping' }] }),
      facts: [
        {
          id: 'f',
          title: 'Free delivery over 350',
          path: '/shipping',
          ready: true,
          updatedAt: '2026-10-06T10:01:00Z',
        },
      ],
    });
    show({ discovery: row(), facts: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(actions.readReading).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('reading-feed')).toHaveTextContent('Free delivery over 350');
    expect(screen.getByTestId('reading-feed')).toHaveTextContent('/shipping');
    expect(screen.getByTestId('reading-feed')).toHaveTextContent('Gift wrapping');
    expect(screen.getByTestId('reading-next')).toHaveAttribute('href', '/onboarding/learned');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(actions.readReading).toHaveBeenCalledTimes(1);
  });

  it('a look that fails says so and keeps looking - it is not "not started"', async () => {
    actions.readReading.mockResolvedValue(null);
    show({ discovery: row(), facts: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByTestId('reading-missed')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(actions.readReading).toHaveBeenCalledTimes(2);
  });

  it('a read that never shows up says it did not start, and offers the way back', async () => {
    actions.readReading.mockResolvedValue({ discovery: null, facts: [] });
    show({ discovery: null, facts: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WAIT_MS);
    });
    expect(screen.getByTestId('reading-lead')).toHaveTextContent("The read hasn't started");
    expect(screen.getByTestId('reading-again')).toHaveAttribute('href', '/onboarding/website');
  });

  it('failed: says so, with the way back', () => {
    show({ discovery: row({ status: 'FAILED', scanPhase: 'failed' }), facts: [] });
    expect(screen.getByTestId('reading-lead')).toHaveTextContent("couldn't finish reading");
    expect(screen.getByTestId('reading-again')).toBeInTheDocument();
  });

  it('facts from an earlier read are not "found just now"', () => {
    show({
      discovery: row(),
      facts: [
        {
          id: 'old',
          title: 'Old fact',
          path: '/x',
          ready: true,
          updatedAt: '2026-10-01T00:00:00Z',
        },
      ],
    });
    expect(screen.getByTestId('reading-feed')).not.toHaveTextContent('Old fact');
  });
});
