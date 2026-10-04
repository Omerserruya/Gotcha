import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import outreach from '@/i18n/messages/en/outreach.json';

/* Both reach real people or Meta: spies, always. */
const sendCampaign = vi.hoisted(() => vi.fn());
const submitTemplate = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ sendCampaign, submitTemplate }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { SendCampaign, SubmitTemplate } from './SendButtons';

beforeEach(() => {
  sendCampaign.mockReset();
  submitTemplate.mockReset();
});
const intl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ outreach }}>
      {node}
    </NextIntlClientProvider>,
  );

describe('★★ Send and Submit ask first — they reach outside', () => {
  it('Send: the first press names how many; only the second sends', async () => {
    sendCampaign.mockResolvedValue({ ok: true });
    intl(<SendCampaign id="b1" count={1240} />);
    await userEvent.click(screen.getByTestId('send-b1'));
    expect(sendCampaign).not.toHaveBeenCalled();
    expect(screen.getByText('This goes to 1,240 people. Send it now?')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('send-yes-b1'));
    expect(sendCampaign).toHaveBeenCalledWith('b1');
    expect(screen.getByTestId('send-done-b1')).toHaveTextContent('Sending');
  });

  it('Not yet sends nothing; a refusal is ours, the platform’s reason on its title', async () => {
    intl(<SendCampaign id="b1" count={0} />);
    await userEvent.click(screen.getByTestId('send-b1'));
    await userEvent.click(screen.getByTestId('send-cancel-b1'));
    expect(sendCampaign).not.toHaveBeenCalled();
    sendCampaign.mockResolvedValue({
      ok: false,
      reason: 'refused',
      why: 'No recipients to send to.',
    });
    await userEvent.click(screen.getByTestId('send-b1'));
    await userEvent.click(screen.getByTestId('send-yes-b1'));
    const problem = screen.getByTestId('send-problem-b1');
    expect(problem).toHaveTextContent("It wasn't sent");
    expect(problem).toHaveAttribute('title', 'No recipients to send to.');
  });

  it('Submit: asks, then submits', async () => {
    submitTemplate.mockResolvedValue({ ok: true });
    intl(<SubmitTemplate id="t1" />);
    await userEvent.click(screen.getByTestId('submit-t1'));
    expect(submitTemplate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('submit-yes-t1'));
    expect(submitTemplate).toHaveBeenCalledWith('t1');
    expect(screen.getByTestId('submit-done-t1')).toHaveTextContent('Submitted');
  });
});
