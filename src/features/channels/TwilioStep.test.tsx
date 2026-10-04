import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';

/* Both write at Twilio: spies. */
const createVoiceChannel = vi.hoisted(() => vi.fn());
const activateVoiceNumbers = vi.hoisted(() => vi.fn());
vi.mock('./voice-actions', () => ({ createVoiceChannel, activateVoiceNumbers }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { TwilioStep } from './TwilioStep';

const SID = `AC${'a1'.repeat(16)}`;
beforeEach(() => {
  createVoiceChannel.mockReset();
  activateVoiceNumbers.mockReset();
});
const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <TwilioStep onClose={() => undefined} />
    </NextIntlClientProvider>,
  );
async function fill(sid = SID) {
  await userEvent.type(screen.getByTestId('twilio-name'), 'Main line');
  await userEvent.type(screen.getByTestId('twilio-sid'), sid);
  await userEvent.type(screen.getByTestId('twilio-token'), 'tok');
}

describe('★★ Phone calls with your own Twilio — inside the Connect panel', () => {
  it('a malformed Account SID is said, and nothing is sent', async () => {
    show();
    await fill('AC123');
    expect(screen.getByText(/AC followed by 32/)).toBeInTheDocument();
    expect(screen.getByTestId('twilio-connect')).toBeDisabled();
    expect(createVoiceChannel).not.toHaveBeenCalled();
  });

  it('Twilio refusing the details: our sentence, never its raw message', async () => {
    createVoiceChannel.mockResolvedValue({ ok: false, reason: 'twilio' });
    show();
    await fill();
    await userEvent.click(screen.getByTestId('twilio-connect'));
    expect(createVoiceChannel).toHaveBeenCalledWith({
      friendlyName: 'Main line',
      accountSid: SID,
      authToken: 'tok',
    });
    expect(screen.getByTestId('twilio-problem')).toHaveTextContent(
      "Twilio didn't accept those details",
    );
  });

  it('then its numbers, all chosen to start; only the chosen are activated', async () => {
    createVoiceChannel.mockResolvedValue({
      ok: true,
      channel: {
        id: 'v1',
        numbers: [
          { id: 'n1', e164: '+97239214400', friendlyName: null, isActive: false },
          { id: 'n2', e164: '+972526110290', friendlyName: 'Sales', isActive: false },
        ],
      },
    });
    activateVoiceNumbers.mockResolvedValue({ activated: ['n2'], failed: [] });
    show();
    await fill();
    await userEvent.click(screen.getByTestId('twilio-connect'));
    expect(screen.getByTestId('twilio-numbers')).toHaveTextContent(
      'Twilio has 2 numbers on this account.',
    );
    expect(activateVoiceNumbers).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('twilio-number-n1'));
    await userEvent.click(screen.getByTestId('twilio-activate'));
    expect(activateVoiceNumbers).toHaveBeenCalledWith('v1', ['n2']);
    expect(screen.getByTestId('twilio-done')).toHaveTextContent(
      'GOTCHA answers calls on 1 number now.',
    );
  });

  it('an account with no numbers: said; nothing to activate', async () => {
    createVoiceChannel.mockResolvedValue({ ok: true, channel: { id: 'v1', numbers: [] } });
    show();
    await fill();
    await userEvent.click(screen.getByTestId('twilio-connect'));
    expect(screen.getByTestId('twilio-no-numbers')).toBeInTheDocument();
    expect(screen.getByTestId('twilio-activate')).toBeDisabled();
  });
});
