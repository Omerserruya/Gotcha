import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

/* Switching changes what customers get: the write is a spy. */
const setResponseMode = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ setResponseMode }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ModeSwitch } from './ModeSwitch';

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      <ModeSwitch channelAccountId="ca1" current="HUMAN_WITH_COPILOT" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  setResponseMode.mockReset();
  refresh.mockReset();
});

describe('★★ 13b - AI mode, 02’s two segments, live', () => {
  it('the current one is marked; pressing it writes nothing', async () => {
    show();
    expect(screen.getByTestId('mode-HUMAN_WITH_COPILOT-ca1')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByTestId('mode-HUMAN_WITH_COPILOT-ca1'));
    expect(setResponseMode).not.toHaveBeenCalled();
  });

  it('the other asks first - what changes for customers - then switches and re-reads', async () => {
    setResponseMode.mockResolvedValue({ ok: true, data: {} });
    show();
    await userEvent.click(screen.getByTestId('mode-AI_AUTO_REPLY-ca1'));
    expect(screen.getByTestId('mode-ask-ca1')).toHaveTextContent('answer on its own');
    expect(setResponseMode).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('mode-yes-ca1'));
    expect(setResponseMode).toHaveBeenCalledWith('ca1', 'AI_AUTO_REPLY');
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal is said; nothing moved', async () => {
    setResponseMode.mockResolvedValue({ ok: false, reason: 'failed' });
    show();
    await userEvent.click(screen.getByTestId('mode-AI_AUTO_REPLY-ca1'));
    await userEvent.click(screen.getByTestId('mode-yes-ca1'));
    expect(screen.getByRole('alert')).toHaveTextContent('didn’t switch');
    expect(refresh).not.toHaveBeenCalled();
  });
});
