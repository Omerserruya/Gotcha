import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { campaignSchema } from '@/api/contracts/outreach';
import messages from '@/i18n/messages/en/outreach.json';

import { CampaignCard } from './CampaignCard';

/**
 * Screen 05's campaign card.
 *
 * This file exists because the card shipped through a capture rendering three
 * counters that are always zero — and it passed, because this tenant has no
 * broadcasts, so the card has never been photographed with a campaign behind
 * it. **The screen was accepted on its empty state.**
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'outreach') =>
    createTranslator({ locale: 'en', messages: { outreach: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

vi.mock('./StopCampaign', () => ({ StopCampaign: () => null }));

const campaign = (over: Record<string, unknown> = {}) =>
  campaignSchema.parse({
    id: 'c1',
    name: 'September wholesale',
    status: 'SENT',
    createdAt: '2026-09-20T09:00:00.000Z',
    totalRecipients: 400,
    sentCount: 392,
    failedCount: 8,
    ...over,
  });

const show = async (over: Record<string, unknown> = {}, detailed = true) =>
  render(await CampaignCard({ campaign: campaign(over), detailed }));

describe('★★ a measurement nobody took is never shown as zero', () => {
  it('renders no delivered, opened or replied counter at all', async () => {
    /*
     * They were `<Counter value={campaign.deliveredCount} />` and friends.
     * All three are initialised to zero and nothing in the monorepo
     * increments them, so a merchant whose campaign WAS delivered and read
     * saw "0 delivered · 0 opened · 0 replied".
     *
     * Three measurements presented as findings, none of them taken — the
     * calm wrong value at its purest: not a crash, not a blank, three
     * plausible numbers.
     */
    const { container } = await show({ deliveredCount: 0, readCount: 0, repliedCount: 0 });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/0\s*delivered/i);
    expect(text).not.toMatch(/0\s*opened/i);
    expect(text).not.toMatch(/0\s*replied/i);
  });

  it('★ says delivered and opened are COMING, because the data exists', async () => {
    /*
     * `Message.broadcastId` is indexed and `Message.status` is updated from
     * delivery receipts — this tenant has READ 139 · DELIVERED 8. So these
     * are a groupBy away, and "not shown yet" is true where "none" would be
     * false.
     */
    await show();
    // One line on the screen, the reason as its tooltip — 02 shows states.
    const pending = screen.getByTestId('pending-c1');
    expect(pending).toHaveTextContent(/aren’t counted yet/i);
    expect(pending.getAttribute('title')).toMatch(/aren't shown yet/i);
    expect(pending.getAttribute('title')).toMatch(/receipts do arrive/i);
  });

  it('★★ and says replied is ABSENT, which is a different fact', async () => {
    /*
     * No inbound path carries a broadcast id and `repliedAt` is never
     * written. So this one is not pending — there is nothing to count, and
     * one sentence for both would promise a number that is not coming.
     */
    await show();
    const absent = screen.getByTestId('no-replies-c1');
    expect(absent).toHaveTextContent(/can’t be traced back/i);
    expect(absent.getAttribute('title')).toMatch(/can't yet tell you who replied/i);
    expect(absent.getAttribute('title')).toMatch(/nothing to count/i);
    // Never the pending sentence: these are different futures.
    expect(absent.getAttribute('title')).not.toMatch(/aren't shown yet/i);
    expect(absent).not.toHaveTextContent(/counted yet/i);
  });

  it('keeps the two numbers that ARE written', async () => {
    // `broadcast.worker.ts:209` writes sentCount and failedCount at send
    // time. Those are real and stay.
    await show();
    expect(screen.getByTestId('sent-c1')).toHaveTextContent(/392/);
    expect(screen.getByTestId('failed-c1')).toHaveTextContent(/8/);
  });

  it('shows none of it on the undetailed card', async () => {
    // Screen 05's in-flight list shows the headline only.
    await show({}, false);
    expect(screen.queryByTestId('pending-c1')).toBeNull();
    expect(screen.queryByTestId('no-replies-c1')).toBeNull();
    expect(screen.getByTestId('sent-c1')).toBeInTheDocument();
  });
});
