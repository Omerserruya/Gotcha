import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import common from '@/i18n/messages/en/common.json';
import commonHe from '@/i18n/messages/he/common.json';

import { BackoffRetry, RETRY_WAITS_S, retryWait } from './BackoffRetry';

/** ★★ A failed read is retried by a person, and less often each time (prod, 2026-11-16). */
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const show = (locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ common: locale === 'en' ? common : commonHe }}>
      <BackoffRetry />
    </NextIntlClientProvider>,
  );
const button = () => screen.getByTestId('backoff-retry');
const wait = (seconds: number) => act(async () => vi.advanceTimersByTimeAsync(seconds * 1000));

beforeEach(() => {
  refresh.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('★★ BackoffRetry', () => {
  it('★★ never asks on its own, however long the page stays open', async () => {
    show();
    await wait(60 * 60);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★★ a press asks once; then the button rests 5, 15, 30, 60, 60 s and says so', async () => {
    show();
    for (const [i, rest] of [5, 15, 30, 60, 60].entries()) {
      expect(button()).toBeEnabled();
      expect(button()).toHaveTextContent('Try again');
      fireEvent.click(button());
      expect(refresh).toHaveBeenCalledTimes(i + 1);
      expect(button()).toBeDisabled();
      expect(button()).toHaveTextContent(`Try again in ${rest}s`);
      await wait(rest - 1);
      expect(button()).toBeDisabled();
      expect(button()).toHaveTextContent('Try again in 1s');
      await wait(1);
    }
    expect(button()).toBeEnabled();
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it('★ the waits never shrink and stop at a minute', () => {
    expect(RETRY_WAITS_S.every((s, i) => i === 0 || s > RETRY_WAITS_S[i - 1]!)).toBe(true);
    expect(retryWait(0)).toBe(5);
    expect(retryWait(99)).toBe(60);
    expect(retryWait(-1)).toBe(5);
  });

  it('★ in Hebrew, in plural address', () => {
    show('he');
    fireEvent.click(button());
    expect(button()).toHaveTextContent('אפשר לנסות שוב בעוד 5 שניות');
  });
});
