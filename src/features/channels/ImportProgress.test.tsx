import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { importStatusSchema } from '@/api/contracts/historical-import';
import messages from '@/i18n/messages/en/channels.json';

import { ImportProgress } from './ImportProgress';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels: messages }, namespace }),
  getLocale: async () => 'en',
}));

const render13e = async (over: Record<string, unknown> = {}) =>
  render(
    await ImportProgress({
      status: importStatusSchema.parse({ id: 'i1', stage: 'analyzing', ...over }),
    }),
  );

describe('★ the number is already live, said first', () => {
  it('leads with the thing the merchant is worried about', async () => {
    await render13e();
    const live = screen.getByTestId('import-live');
    expect(live).toHaveTextContent(/already live/i);
    expect(live).toHaveTextContent(/does not hold anything up/i);
  });
});

describe("★ three states, and the design's five names as prose", () => {
  it('names what happens during analyzing without implying steps', async () => {
    /*
     * The platform reports `analyzing` for the design's last THREE steps. A
     * five-segment bar would show three that flip together, and simultaneity
     * reads as "those took no time" rather than "we cannot see inside this".
     */
    await render13e();
    const what = screen.getByTestId('import-what-happens');
    expect(what).toHaveTextContent(/language and tone/i);
    expect(what).toHaveTextContent(/questions you answer most/i);
    expect(what).toHaveTextContent(/remembering the customers/i);

    // And says they are not sequential, so nobody watches for an order.
    expect(screen.getByTestId('import-no-order')).toHaveTextContent(/happen together/i);
  });

  it('renders one stage value, never a five-step bar', async () => {
    await render13e();
    expect(screen.getByTestId('import')).toHaveAttribute('data-stage', 'analyzing');
    expect(screen.getByTestId('import-stage')).toHaveTextContent(/reading it/i);
  });
});

describe('★ the wait is filled with counts, not findings', () => {
  it('reports work done as rows read', async () => {
    /*
     * `topTopics` lands at stage eight of nine, so topics cannot fill the
     * wait — they end it. The counts are "rows the pipeline actually
     * finished", which is the licence to say "read".
     */
    await render13e({
      conversationsExtracted: 1240,
      conversationsEligible: 3900,
      customersAnalyzed: 210,
      customersTotal: 540,
      knowledgeCandidateCount: 18,
    });
    expect(screen.getByTestId('import-conversations')).toHaveTextContent(
      /1,240 of 3,900 conversations read/i,
    );
    expect(screen.getByTestId('import-customers')).toHaveTextContent(/210 of 540/);
    expect(screen.getByTestId('import-answers')).toHaveTextContent(/18 answers found/i);
  });

  it('★ does not render a ratio against a denominator of zero', async () => {
    // "0 of 0 read" is not progress — it is a pipeline that has not started
    // counting, and as a ratio it invites the reader to conclude nothing is
    // happening.
    await render13e({ conversationsExtracted: 40, conversationsEligible: 0 });
    expect(screen.getByTestId('import-conversations')).toHaveTextContent(
      /40 conversations read so far/i,
    );
    expect(screen.queryByTestId('import-customers')).toBeNull();
  });

  it('says nothing has been counted rather than showing zeroes', async () => {
    await render13e();
    expect(screen.getByTestId('import-not-counted')).toHaveTextContent(/nothing has been counted/i);
    expect(screen.queryByTestId('import-counts')).toBeNull();
  });

  it('never presents topics as progress', async () => {
    // They arrive at the end. Rendering them mid-run would claim a discovery
    // that never happened progressively.
    await render13e({ topTopics: [{ topic: 'shipping' }] });
    expect(screen.getByTestId('import')).not.toHaveTextContent(/shipping/i);
  });
});

describe('★ the email exists and the notification does not', () => {
  it('promises only the email, and names its condition', async () => {
    /*
     * `finalize.stage.ts` queues a completion email to owners; nothing in it
     * publishes an in-app notification. And it has a named branch for "no
     * owner to notify", so a workspace whose owner has no address gets
     * silence.
     */
    await render13e();
    const email = screen.getByTestId('import-email');
    expect(email).toHaveTextContent(/an email goes to the workspace owners/i);
    expect(email).toHaveTextContent(/only goes to owners who have an email address/i);
    // The design promises a notification too. We do not have one.
    expect(screen.getByTestId('import')).not.toHaveTextContent(/notification/i);
  });

  it('says it is safe to close', async () => {
    await render13e();
    expect(screen.getByTestId('import-safe-to-close')).toHaveTextContent(/keeps running/i);
  });
});

describe('★ a failure names the stage that broke', () => {
  it('says where it stopped when the platform knows', async () => {
    // "Failed" alone gives a merchant nothing to act on or repeat to support.
    await render13e({ stage: 'failed', failedStage: 'knowledge-extraction' });
    const failed = screen.getByTestId('import-failed');
    expect(failed).toHaveTextContent(/knowledge-extraction/);
    expect(failed).toHaveTextContent(/nothing from this import is in use/i);
  });

  it('falls back without inventing a stage', async () => {
    await render13e({ stage: 'failed' });
    expect(screen.getByTestId('import-failed')).toHaveTextContent(/stopped before finishing/i);
  });

  it('stops showing progress once it has stopped', async () => {
    await render13e({ stage: 'failed' });
    expect(screen.queryByTestId('import-running')).toBeNull();
  });
});

describe('the two terminal states that are not failures', () => {
  it('says the work is done and nothing is in use yet', async () => {
    await render13e({ stage: 'ready' });
    expect(screen.getByTestId('import-ready')).toHaveTextContent(/until you approve it/i);
  });

  it('explains an absent history rather than calling it an error', async () => {
    await render13e({ stage: 'unavailable' });
    expect(screen.getByTestId('import-unavailable')).toHaveTextContent(
      /usually because it is new/i,
    );
    expect(screen.queryByTestId('import-failed')).toBeNull();
  });
});
