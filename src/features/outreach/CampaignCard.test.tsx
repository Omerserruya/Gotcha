import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { campaignSchema } from '@/api/contracts/outreach';
import channels from '@/i18n/messages/en/channels.json';
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

// 05b's link; the router is not in jsdom.
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'outreach') =>
    createTranslator({ locale: 'en', messages: { outreach: messages, channels }, namespace }),
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

describe('★ "When" says it once', () => {
  it('⚠ "Sending since …", not "Sending · Sending since …"', async () => {
    render(
      await CampaignCard({
        campaign: campaignSchema.parse({
          id: 'c9',
          name: 'n',
          status: 'SENDING',
          createdAt: '2026-10-02T09:00:00.000Z',
          startedAt: '2026-10-02T09:00:00.000Z',
        }),
        detailed: true,
      }),
    );
    const when = screen.getByTestId('when-c9');
    expect(when.textContent?.match(/Sending/g)).toHaveLength(1);
    expect(when).toHaveTextContent(/Sending since/);
  });
});

describe('★ 05b — a campaign that has gone out links to what it did', () => {
  it.each([
    ['COMPLETED', true],
    ['CANCELLED', true],
    ['FAILED', true],
    ['SENDING', false],
    ['SCHEDULED', false],
    ['DRAFT', false],
  ] as const)('%s → link: %s', async (status, linked) => {
    const { container } = render(
      await CampaignCard({
        campaign: campaignSchema.parse({
          id: 'b1',
          name: 'x',
          status,
          createdAt: '2026-10-02T08:00:00.000Z',
        }),
        detailed: true,
      }),
    );
    const link = container.querySelector('[data-testid="results-b1"]');
    if (linked) expect(link).toHaveAttribute('href', '/outreach/campaigns/b1');
    else expect(link).toBeNull();
  });
});

describe('★★ 02\'s "Who": who they are, then how many', () => {
  const who = async (audience: unknown) => {
    await show({ audience });
    return screen.getByTestId('campaign-who');
  };

  it("★ two lines in 02's shape: the audience, then the green count", async () => {
    const dd = await who({ type: 'composite', everyone: true, channel: 'WHATSAPP' });
    const [line, count] = Array.from(dd.children);
    expect(line).toHaveTextContent('All your customers on WhatsApp');
    expect(count).toHaveTextContent('400 people');
  });

  it('everyone, with no channel scope', async () => {
    expect(await who({ type: 'composite', everyone: true })).toHaveTextContent(
      /^All your customers400 people$/,
    );
  });

  it('hand-picked: local contacts and CRM chips, counted together', async () => {
    expect(
      await who({ type: 'composite', contactIds: ['a', 'b'], crmContacts: [{ id: 'z' }] }),
    ).toHaveTextContent('3 people you picked');
  });

  it('manual, the older form, says the same', async () => {
    expect(await who({ type: 'manual', contactIds: ['a'] })).toHaveTextContent(
      '1 person you picked',
    );
  });

  it('no audience: the people were added to it directly', async () => {
    expect(await who(null)).toHaveTextContent('People added to it directly');
  });

  it('★★ a rule is never put into words — "a saved audience"', async () => {
    // `tags` is Json and the resolver filters it as a scalar: "tagged VIP"
    // would describe a selection the platform does not make.
    const tagged = {
      type: 'composite',
      contactIds: ['a'],
      rules: { all: [{ field: 'tags', op: 'contains', value: 'VIP' }] },
    };
    expect(await who(tagged)).toHaveTextContent(/^A saved audience/);
  });

  it('filter and saved forms: "a saved audience"', async () => {
    const { unmount } = await show({
      audience: {
        type: 'filter',
        rules: { any: [{ field: 'city', op: 'equals', value: 'Haifa' }] },
      },
    });
    expect(screen.getByTestId('campaign-who')).toHaveTextContent(/^A saved audience/);
    unmount();
    expect(await who({ type: 'saved', audienceId: 'aud_1' })).toHaveTextContent(
      /^A saved audience/,
    );
  });

  it('★★ an unknown form — dev\'s own `{"note":"ui test"}` — is "a saved audience", never a rejected campaign', async () => {
    expect(await who({ note: 'ui test' })).toHaveTextContent(/^A saved audience400 people$/);
  });

  it('★ an unknown form is never read as "everyone" — only a composite can say that', async () => {
    expect(await who({ everyone: true })).toHaveTextContent(/^A saved audience/);
  });

  it('a value that is not even an object is "a saved audience" too', async () => {
    expect(await who('a string')).toHaveTextContent(/^A saved audience/);
  });
});
