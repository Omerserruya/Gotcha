import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requiredTemplatesSchema } from '@/api/contracts/required-templates';
import { embeddedSignupLaunchSchema } from '@/api/contracts/whatsapp-connect';
import messages from '@/i18n/messages/en/channels.json';

/* Nothing here reaches Meta: the SDK is stubbed; inspect and connect are spies. */
const inspectNumbers = vi.hoisted(() => vi.fn());
const connectNumber = vi.hoisted(() => vi.fn());
vi.mock('./whatsapp-actions', () => ({ inspectNumbers, connectNumber }));
/* The required templates' reads and writes are spies too: a submit is a real Meta write. */
const required = vi.hoisted(() => ({
  requiredForConnected: vi.fn(),
  saveRequiredTemplate: vi.fn(),
  loadRequiredTemplates: vi.fn(),
}));
vi.mock('./required-templates-actions', () => required);
vi.mock('./signup/facebook-sdk', () => ({ useFacebookSdk: () => 'ready' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ConnectWhatsApp } from './ConnectWhatsApp';

const launch = embeddedSignupLaunchSchema.parse({
  appId: 'app',
  configId: 'cfg-1',
  responseType: 'code',
  extras: { sessionInfoVersion: '3' },
  configured: true,
  inspectPath: 'business-app',
});
const fresh = embeddedSignupLaunchSchema.parse({
  ...launch,
  configId: 'cfg-new',
  inspectPath: 'new',
});
const show = (l: typeof launch | null = launch, n: typeof launch | null = fresh) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <ConnectWhatsApp
        launches={{ coexistence: l, newNumber: n }}
        closeHref="/settings/channels?panel=whatsapp"
      />
    </NextIntlClientProvider>,
  );

const login = vi.fn();
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  inspectNumbers.mockReset();
  connectNumber.mockReset();
  required.requiredForConnected.mockReset();
  required.saveRequiredTemplate.mockReset();
  required.requiredForConnected.mockResolvedValue(null);
  push.mockReset();
  login.mockReset();
  window.FB = { init: vi.fn(), login };
});
afterEach(() => {
  vi.useRealTimers();
  delete window.FB;
});

const candidate = (over: Record<string, unknown>) => ({
  phoneNumberId: 'p1',
  phoneNumber: '+972 52 611 0290',
  name: 'Aviv Studio',
  usesBusinessApp: false,
  alreadyConnectedHere: false,
  scenario: 'NEW_NUMBER',
  message: null,
  customerAction: null,
  blockers: [],
  ...over,
});

/** Through Meta to 13d, with these numbers. */
async function toNumbers(candidates: unknown[]) {
  inspectNumbers.mockResolvedValue({ sessionId: 's1', candidates });
  show();
  await userEvent.click(screen.getByTestId('continue-meta'));
  await act(async () => {
    login.mock.calls[0]![0]({ authResponse: { code: 'abc' } });
    await vi.advanceTimersByTimeAsync(700);
  });
}

describe('★★ 13c - one question before Meta', () => {
  it('step 1: two paths, "You’ll need", and nothing opened until Continue', async () => {
    show();
    expect(
      screen.getByTestId('connect-steps').querySelector('[aria-current="step"]'),
    ).toHaveTextContent('Where it lives');
    expect(screen.getByTestId('path-business_app')).toHaveAttribute('aria-checked', 'true');
    // Omer: Meta asks the same thing again - said once, quietly, under the two.
    expect(screen.getByTestId('paths-again')).toHaveTextContent(
      'Meta asks this again in its window - pick the same answer there.',
    );
    await userEvent.click(screen.getByTestId('path-new'));
    expect(screen.getByTestId('path-new')).toHaveAttribute('aria-checked', 'true');
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByTestId('connect-cancel')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp',
    );
  });

  it('Continue opens Meta with exactly the server’s config; the stepper moves to Meta', async () => {
    show();
    await userEvent.click(screen.getByTestId('continue-meta'));
    expect(login.mock.calls[0]![1]).toStrictEqual({
      config_id: 'cfg-1',
      response_type: 'code',
      override_default_response_type: true,
      extras: { sessionInfoVersion: '3' },
    });
    expect(
      screen.getByTestId('connect-steps').querySelector('[aria-current="step"]'),
    ).toHaveTextContent('Meta');
    expect(screen.getByTestId('connect-waiting')).toBeInTheDocument();
  });

  it('★ each choice launches with ITS parameters, and inspect follows its path (294adc0c)', async () => {
    inspectNumbers.mockResolvedValue({ sessionId: 's1', candidates: [] });
    show();
    await userEvent.click(screen.getByTestId('path-new'));
    await userEvent.click(screen.getByTestId('continue-meta'));
    expect(login.mock.calls[0]![1].config_id).toBe('cfg-new');
    await act(async () => {
      login.mock.calls[0]![0]({ authResponse: { code: 'abc' } });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(inspectNumbers.mock.calls[0]![2]).toBe('new');
  });

  it('the Business app choice inspects as business-app', async () => {
    inspectNumbers.mockResolvedValue({ sessionId: 's1', candidates: [] });
    show();
    await userEvent.click(screen.getByTestId('continue-meta'));
    expect(login.mock.calls[0]![1].config_id).toBe('cfg-1');
    await act(async () => {
      login.mock.calls[0]![0]({ authResponse: { code: 'abc' } });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(inspectNumbers.mock.calls[0]![2]).toBe('business-app');
  });

  it('not set up on the server: Continue is off, with why', () => {
    const off = embeddedSignupLaunchSchema.parse({ ...launch, configured: false });
    show(off, off);
    expect(screen.getByTestId('continue-meta')).toBeDisabled();
    expect(screen.getByTestId('continue-meta').getAttribute('title')).toMatch(/isn't set up/);
  });

  it('the window’s assets are believed from Meta only', async () => {
    inspectNumbers.mockResolvedValue({ sessionId: 's1', candidates: [] });
    show();
    await userEvent.click(screen.getByTestId('continue-meta'));
    const post = (origin: string, waba: string) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin,
            data: JSON.stringify({
              type: 'WA_EMBEDDED_SIGNUP',
              event: 'FINISH',
              data: { business_id: 'b1', waba_ids: [waba] },
            }),
          }),
        );
      });
    post('https://www.facebook.com', 'w1');
    post('https://evilfacebook.com', 'w-evil');
    await act(async () => {
      login.mock.calls[0]![0]({ authResponse: { code: 'abc' } });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(inspectNumbers.mock.calls[0]![1].wabaIds).toEqual(['w1']);
    expect(await screen.findByTestId('connect-none')).toBeInTheDocument();
  });

  it('closed without a code: back on step 1, nothing inspected - and SAID, never silent', async () => {
    show();
    await userEvent.click(screen.getByTestId('continue-meta'));
    act(() => login.mock.calls[0]![0]({ authResponse: null, status: 'unknown' }));
    expect(inspectNumbers).not.toHaveBeenCalled();
    expect(screen.getByTestId('path-business_app')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-problem')).toHaveTextContent('You closed Meta');
  });
});

describe('★★ 13d - exactly one number per pass', () => {
  it('the numbers Meta shared; one already here is shown and off; Connect waits for a choice', async () => {
    await toNumbers([
      candidate({ phoneNumberId: 'p1', usesBusinessApp: true, scenario: 'COEXISTENCE' }),
      candidate({
        phoneNumberId: 'p3',
        alreadyConnectedHere: true,
        phoneNumber: '+972 3 921 4400',
      }),
    ]);
    expect(
      screen.getByTestId('connect-steps').querySelector('[aria-current="step"]'),
    ).toHaveTextContent('Number');
    expect(screen.getByText(/Meta shared 2 numbers/)).toBeInTheDocument();
    expect(screen.getByTestId('candidate-p3')).toBeDisabled();
    expect(screen.getByTestId('candidate-p3')).toHaveTextContent('Already connected to GOTCHA');
    expect(screen.getByTestId('connect-number')).toBeDisabled();
    await userEvent.click(screen.getByTestId('candidate-p1'));
    expect(screen.getByTestId('connect-number')).toHaveTextContent('Connect and import');
  });

  it('connects the one chosen, then its required templates, then to 13e', async () => {
    connectNumber.mockResolvedValue({ ok: true, pendingAction: null });
    required.requiredForConnected.mockResolvedValue({
      channelAccountId: 'ca2',
      read: {
        ok: true,
        data: requiredTemplatesSchema.parse({
          channelAccountId: 'ca2',
          canSubmit: true,
          languages: ['en'],
          items: [
            { role: 'reopen', name: 'gotcha_reopen', language: 'en', state: 'missing', body: 'Hi' },
          ],
        }),
      },
    });
    await toNumbers([
      candidate({ phoneNumberId: 'p1' }),
      candidate({ phoneNumberId: 'p2', phoneNumber: '+972 3 555 0000' }),
    ]);
    await userEvent.click(screen.getByTestId('candidate-p2'));
    await userEvent.click(screen.getByTestId('connect-number'));
    expect(connectNumber).toHaveBeenCalledWith('s1', 'p2', undefined);
    expect(required.requiredForConnected).toHaveBeenCalledWith('p2', '+972 3 555 0000');
    // Step 4: the templates, and no move until Continue.
    expect(await screen.findByTestId('connect-templates')).toBeInTheDocument();
    expect(
      screen.getByTestId('connect-steps').querySelector('[aria-current="step"]'),
    ).toHaveTextContent('Required templates');
    expect(screen.getByTestId('required-state-reopen-en')).toHaveTextContent('Not saved yet');
    expect(push).not.toHaveBeenCalled();
    // ★ Passing the step sends nothing to Meta.
    await userEvent.click(screen.getByTestId('templates-continue'));
    expect(required.saveRequiredTemplate).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/settings/channels?panel=whatsapp&view=progress');
  });

  it('the new number not found yet: said where its templates wait, and Continue', async () => {
    connectNumber.mockResolvedValue({ ok: true, pendingAction: null });
    await toNumbers([candidate({ phoneNumberId: 'p1' })]);
    await userEvent.click(screen.getByTestId('candidate-p1'));
    await userEvent.click(screen.getByTestId('connect-number'));
    expect(await screen.findByTestId('required-not-found')).toHaveTextContent(
      'Settings · Channels · WhatsApp · Templates',
    );
    await userEvent.click(screen.getByTestId('templates-continue'));
    expect(push).toHaveBeenCalledWith('/settings/channels?panel=whatsapp&view=progress');
  });

  it('a 403 on the read: only an Owner, in words', async () => {
    connectNumber.mockResolvedValue({ ok: true, pendingAction: null });
    required.requiredForConnected.mockResolvedValue({
      channelAccountId: 'ca1',
      read: { ok: false, reason: 'forbidden' },
    });
    await toNumbers([candidate({ phoneNumberId: 'p1' })]);
    await userEvent.click(screen.getByTestId('candidate-p1'));
    await userEvent.click(screen.getByTestId('connect-number'));
    expect(await screen.findByTestId('required-unread')).toHaveTextContent(
      'Only an Owner can see and send the required templates.',
    );
  });

  it('a number that needs its PIN: six digits, then sent with it', async () => {
    connectNumber.mockResolvedValue({ ok: true, pendingAction: null });
    await toNumbers([candidate({ phoneNumberId: 'p1', customerAction: 'TWO_STEP_PIN' })]);
    await userEvent.click(screen.getByTestId('candidate-p1'));
    expect(screen.getByTestId('connect-number')).toBeDisabled();
    await userEvent.type(screen.getByTestId('connect-pin'), '12a3456');
    expect(screen.getByTestId('connect-pin')).toHaveValue('123456');
    await userEvent.click(screen.getByTestId('connect-number'));
    expect(connectNumber).toHaveBeenCalledWith('s1', 'p1', '123456');
  });

  describe('★★ Meta still needs a step: said in our words from the code, and no move to 13e', () => {
    const pending = messages.whatsapp.wizard.number.pendingAction;
    async function connectWith(code: string) {
      connectNumber.mockResolvedValue({
        ok: true,
        pendingAction: code,
        message: 'RAW ENGLISH FROM THE ROUTE',
      });
      await toNumbers([candidate({ phoneNumberId: 'p1' })]);
      await userEvent.click(screen.getByTestId('candidate-p1'));
      await userEvent.click(screen.getByTestId('connect-number'));
      const said = screen.getByTestId('connect-failure');
      expect(said).not.toHaveTextContent('RAW ENGLISH');
      expect(push).not.toHaveBeenCalled();
      return said;
    }

    it.each([
      ['TWO_STEP_PIN', pending.twoStepPin],
      ['VERIFICATION_CODE', pending.verificationCode],
      ['BUSINESS_APP_CONFIRMATION', pending.businessAppConfirmation],
      ['BUSINESS_VERIFICATION', pending.businessVerification],
      ['DISPLAY_NAME_REVIEW', pending.displayNameReview],
    ])('%s', async (code, sentence) => {
      expect((await connectWith(code)).textContent).toBe(sentence);
    });

    it('an unknown code: the generic sentence', async () => {
      expect((await connectWith('SOMETHING_NEW')).textContent).toBe(
        messages.whatsapp.wizard.number.pending,
      );
    });
  });

  describe('★★ a blocked number says why in our words - never the platform’s sentence', () => {
    const flow = messages.whatsapp.wizard.number.flow;
    const blockedRow = async (...codes: string[]) => {
      await toNumbers([
        candidate({
          phoneNumberId: 'p1',
          scenario: 'BLOCKED',
          message: 'RAW ENGLISH FROM THE ROUTE',
          blockers: codes.map((code) => ({
            code,
            message: 'RAW BLOCKER ENGLISH',
            customerActionable: true,
          })),
        }),
      ]);
      const row = screen.getByTestId('candidate-p1');
      expect(row).toBeDisabled();
      expect(row).not.toHaveTextContent('RAW');
      return row;
    };

    it.each([
      ['CONNECTED_ELSEWHERE', flow.blockedBy.connectedElsewhere],
      ['ON_PREMISE', flow.blockedBy.onPremise],
      ['PHONE_BANNED', flow.blockedBy.banned],
      ['WEBHOOK_OVERRIDDEN', flow.blockedBy.otherPlatform],
      ['MISSING_PERMISSION_WHATSAPP_BUSINESS_MANAGEMENT', flow.blockedBy.permission],
      ['MISSING_PERMISSION_WHATSAPP_BUSINESS_MESSAGING', flow.blockedBy.permission],
    ])('%s', async (code, sentence) => {
      expect(await blockedRow(code)).toHaveTextContent(sentence);
    });

    it('no code it knows: the generic sentence', async () => {
      expect(await blockedRow('SOMETHING_NEW')).toHaveTextContent(flow.blocked);
    });
  });

  it('who answers, the import and contacts are drawn, each saying why; Back returns to step 1', async () => {
    await toNumbers([candidate({ phoneNumberId: 'p1' })]);
    for (const id of ['connect-owner', 'connect-import', 'connect-contacts']) {
      expect(screen.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId(id).getAttribute('title')).toBeTruthy();
    }
    await userEvent.click(screen.getByTestId('connect-back'));
    expect(screen.getByTestId('path-business_app')).toBeInTheDocument();
  });
});
