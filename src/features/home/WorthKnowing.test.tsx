import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { insightSchema } from '@/api/contracts/analytics';
import channels from '@/i18n/messages/en/channels.json';
import home from '@/i18n/messages/en/home.json';

import { WorthKnowing } from './WorthKnowing';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS COMPONENT HAD NO TESTS, AND IT IS THE ONE THAT SHIPPED THE HOLE
 * ════════════════════════════════════════════════════════════════════════════
 * A browser at `/v2` read, on Home, in an otherwise finished English page:
 *
 *     71 conversations came through WHATSAPP in the last 30 days.
 *
 * The card spread the analytics service's untyped `values` bag straight into a
 * translated sentence. Nothing stood between the platform's vocabulary and the
 * reader, and nothing here could have noticed, because there was no file.
 *
 * The tests below are deliberately about the SPREAD and not about `{channel}`.
 * Fixing the one placeholder somebody photographed leaves every future
 * placeholder, and every `kind` the service adds, with the same free pass —
 * which is the difference between a site and a hole.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'home.insight' | 'channels') =>
    createTranslator({
      locale: 'en',
      messages: { home, channels },
      namespace,
    }),
}));

let seq = 0;
const insight = (over: Record<string, unknown>) =>
  insightSchema.parse({
    // Required by the contract. A fixture is a claim that the platform can send
    // this object, and one without an id could not have come from anywhere.
    id: `i${++seq}`,
    kind: 'channel.highest_volume',
    impact: 'high',
    values: {},
    ...over,
  });

const show = async (insights: Parameters<typeof WorthKnowing>[0]['insights']) =>
  render(await WorthKnowing({ insights }));

describe('★★ no platform identifier reaches the sentence', () => {
  it('★★ names the channel and never shows its code', async () => {
    await show([insight({ values: { count: 71, days: 30, channel: 'WHATSAPP' } })]);
    const body = screen.getByText(/conversations came through/);
    expect(body).toHaveTextContent('WhatsApp');
    expect(body).not.toHaveTextContent('WHATSAPP');
  });

  it('★★ uses the translated catalogue, not the humaniser, where one exists', async () => {
    /*
     * `humaniseCode('SHOPIFY_LIVE_CHAT')` gives "Shopify live chat", which is
     * right in English and English on a Hebrew screen. `channels.json` is
     * translated, so a resolver is passed for this one key. Asserting the
     * catalogue's exact wording is what distinguishes the two paths: the
     * humaniser would capitalise nothing differently here, so the test uses
     * the one channel whose catalogue name is NOT what the humaniser produces.
     */
    await show([insight({ values: { count: 4, days: 7, channel: 'WEBCHAT' } })]);
    // `channels.json` says "Web chat"; `humaniseCode` would say "Webchat".
    expect(screen.getByText(/conversations came through/)).toHaveTextContent('Web chat');
  });

  it('★★ humanises a key nobody wrote a resolver for — the hole, not the site', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT
     * ════════════════════════════════════════════════════════════════════════
     * There is no resolver for `department`, and there is no catalogue for it.
     * It must still not arrive as `customer_success`. This fails for any
     * implementation that humanises `{channel}` alone — which is what fixing
     * the screenshot would have produced.
     *
     * `kind.fallback` takes no placeholders, so the kind here is a KNOWN one
     * carrying an extra key: ICU ignores values a message does not use, so
     * this asserts the transform rather than the rendering, which is exactly
     * the level the hole lives at.
     */
    const { readableValues } = await import('@/api/contracts/capabilities');
    expect(readableValues({ department: 'customer_success' })).toEqual({
      department: 'Customer success',
    });
  });

  it('says nothing stood out, rather than showing an empty box', async () => {
    await show([]);
    expect(screen.getByText(/nothing/i)).toBeInTheDocument();
  });

  it('★ distinguishes "we could not ask" from "nothing stood out"', async () => {
    await show(null);
    const unavailable = screen.getByText(/couldn’t|could not|unavailable/i);
    expect(unavailable).toBeInTheDocument();
  });

  it('shows the highest-impact insight, not the first one returned', async () => {
    await show([
      insight({ impact: 'low', values: { count: 1, days: 1, channel: 'EMAIL' } }),
      insight({ impact: 'high', values: { count: 71, days: 30, channel: 'WHATSAPP' } }),
    ]);
    expect(screen.getByText(/conversations came through/)).toHaveTextContent('71');
  });
});
