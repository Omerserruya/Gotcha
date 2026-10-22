import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { campaignSchema, type Campaign } from '@/api/contracts/outreach';
import channels from '@/i18n/messages/en/channels.json';
import outreach from '@/i18n/messages/en/outreach.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'outreach' | 'channels') =>
    createTranslator({ locale: 'en', messages: { outreach, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

import {
  BroughtIn,
  RepliesByHour,
  ResultStrip,
  resultsLine,
  SaidNothing,
  sendFigures,
  sendHours,
  WroteBack,
} from './CampaignResults';

/**
 * Screen 05b. Only the send is recorded - `sent`, `failed`, `skipped` - so
 * these assert the parts made of it, and that every other part is "-" in
 * its shape rather than a confident zero.
 */
const campaign = (over: Record<string, unknown> = {}): Campaign =>
  campaignSchema.parse({
    id: 'b1',
    name: 'Linen restock · sand king',
    channel: 'WHATSAPP',
    status: 'COMPLETED',
    createdAt: '2026-10-02T08:00:00.000Z',
    startedAt: '2026-10-02T09:10:00.000Z',
    completedAt: '2026-10-02T15:05:00.000Z',
    totalRecipients: 1240,
    sentCount: 1228,
    failedCount: 12,
    ...over,
  });

describe('★ the figures the send gives', () => {
  it('sent, didn’t arrive, never sent', () => {
    expect(sendFigures(campaign({ totalRecipients: 1300 }))).toEqual({
      sent: 1228,
      failed: 12,
      notSent: 60,
    });
    expect(sendFigures(campaign({ totalRecipients: 10 })).notSent).toBe(0);
  });

  it('★ the hours it went out over: from the start hour to the end, at most twelve', () => {
    const hours = sendHours(campaign());
    expect(hours).toHaveLength(7);
    expect(hours[0]!.toISOString()).toBe('2026-10-02T09:00:00.000Z');
    expect(sendHours(campaign({ completedAt: '2026-10-03T15:00:00.000Z' }))).toHaveLength(12);
  });

  it('⚠ an end before the start, inside one hour, is no axis - not one bar', () => {
    // Floored to 15:00, the start would sit before an end of 15:10.
    expect(
      sendHours(
        campaign({
          startedAt: '2026-10-02T15:30:00.000Z',
          completedAt: '2026-10-02T15:10:00.000Z',
        }),
      ),
    ).toEqual([]);
  });

  it('⚠ without both ends there is no axis - never an invented one', () => {
    expect(sendHours(campaign({ completedAt: null }))).toEqual([]);
    expect(sendHours(campaign({ startedAt: null }))).toEqual([]);
    expect(
      sendHours(
        campaign({
          startedAt: '2026-10-02T15:00:00.000Z',
          completedAt: '2026-10-02T09:00:00.000Z',
        }),
      ),
    ).toEqual([]);
  });
});

describe('★★ every part drawn; what nothing records is "-"', () => {
  it('★ the strip: Sent with what did not arrive; the rest "-", never 0', async () => {
    render(await ResultStrip({ campaign: campaign() }));
    expect(screen.getByTestId('results-sent')).toHaveTextContent('1,228');
    expect(screen.getByTestId('results-sent')).toHaveTextContent("12 didn't arrive");
    for (const key of ['delivered', 'opened', 'replied', 'bought', 'optedOut']) {
      expect(screen.getByTestId(`results-${key}`)).toHaveTextContent('-');
      expect(screen.getByTestId(`results-${key}`)).not.toHaveTextContent('0');
    }
  });

  it('nothing failed: no "didn’t arrive" note', async () => {
    render(await ResultStrip({ campaign: campaign({ failedCount: 0 }) }));
    expect(screen.getByTestId('results-sent')).not.toHaveTextContent("didn't arrive");
  });

  it('★ what it brought in: "-", from the messages sent; the actions not live', async () => {
    render(await BroughtIn({ campaign: campaign() }));
    const card = screen.getByTestId('results-brought');
    expect(card).toHaveTextContent('-');
    expect(card).toHaveTextContent('from 1,228 messages');
    expect(screen.getByText('Send this again in a month')).toHaveAttribute('aria-disabled', 'true');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('who read it and said nothing: reads are not recorded, said so; follow-up not live', async () => {
    render(await SaidNothing());
    expect(screen.getByTestId('results-quiet')).toHaveTextContent("Reads aren't recorded");
    expect(screen.getByText('Let it follow up')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ the chart: the real hours as its axis, the bars empty, the reason under it', async () => {
    render(await RepliesByHour({ campaign: campaign() }));
    const chart = screen.getByTestId('results-hours');
    expect(chart.querySelectorAll('li')).toHaveLength(7);
    expect(chart).toHaveTextContent('09:00');
    expect(chart).toHaveTextContent('sent over 7 hours from 09:00');
    expect(chart).toHaveTextContent("Replies aren't linked to campaigns yet.");
  });

  it('what they wrote back keeps its place', async () => {
    render(await WroteBack());
    expect(screen.getByTestId('results-replies')).toHaveTextContent('Nothing recorded yet.');
  });

  it('the header line: finished, how long ago, the channel', async () => {
    const line = await resultsLine(campaign(), new Date('2026-10-02T15:45:00.000Z'));
    expect(line).toBe('Finished 40 minutes ago · WhatsApp');
    expect(await resultsLine(campaign({ status: 'CANCELLED' }), new Date())).toBe(
      'Stopped by you · WhatsApp',
    );
  });
});
