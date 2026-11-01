import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/** Console · enter a workspace as its admin. Mocked: nothing is sent. */
const { actions, assign } = vi.hoisted(() => ({
  actions: { startSupport: vi.fn(), resumeSupport: vi.fn(), endSupport: vi.fn() },
  assign: vi.fn(),
}));
vi.mock('./actions', () => actions);

import { SupportEnter } from './SupportEnter';

const show = (ended = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <SupportEnter tenantId="t9" ended={ended} />
    </NextIntlClientProvider>,
  );
const typeReason = (text: string) =>
  fireEvent.change(screen.getByTestId('support-reason'), { target: { value: text } });
const enter = () => act(async () => fireEvent.click(screen.getByTestId('support-start')));

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('★★ entering support mode from the console', () => {
  it('★ a reason first: Enter is closed until one is written', () => {
    show();
    expect(screen.getByTestId('support-start')).toBeDisabled();
    typeReason('   ');
    expect(screen.getByTestId('support-start')).toBeDisabled();
    typeReason('ticket 42');
    expect(screen.getByTestId('support-start')).toBeEnabled();
  });

  it('★★ entered: the workspace opens with a document load, at Home', async () => {
    actions.startSupport.mockResolvedValue({ ok: true, session: {} });
    show();
    typeReason('ticket 42');
    await enter();
    expect(actions.startSupport).toHaveBeenCalledWith('t9', 'ticket 42');
    expect(assign).toHaveBeenCalledWith('/home');
  });

  it.each(
    Object.keys(consoleEn.support.enter.refusal).filter((r) => r !== 'none' && r !== 'active'),
  )('refused %s: its own words, and nothing opens', async (reason) => {
    actions.startSupport.mockResolvedValue({ ok: false, reason });
    show();
    typeReason('r');
    await enter();
    expect(screen.getByTestId('support-refused')).toHaveTextContent(
      (consoleEn.support.enter.refusal as Record<string, string>)[reason]!,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('★ already in a session: names it, and offers to return to it or end it', async () => {
    actions.startSupport.mockResolvedValue({
      ok: false,
      reason: 'active',
      activeName: 'Other shop',
    });
    actions.resumeSupport.mockResolvedValue({ ok: true, session: {} });
    show();
    typeReason('r');
    await enter();
    expect(screen.getByTestId('support-active')).toHaveTextContent(
      'You are already in support mode in Other shop.',
    );
    await act(async () => fireEvent.click(screen.getByTestId('support-resume')));
    expect(assign).toHaveBeenCalledWith('/home');
  });

  it('ending the other session says so, and leaves this page to enter', async () => {
    actions.startSupport.mockResolvedValue({ ok: false, reason: 'active', activeName: null });
    actions.endSupport.mockResolvedValue({ ok: true, tenantId: null });
    show();
    typeReason('r');
    await enter();
    expect(screen.getByTestId('support-active')).toHaveTextContent(
      'You are already in support mode in another workspace.',
    );
    await act(async () => fireEvent.click(screen.getByTestId('support-end-other')));
    expect(screen.getByTestId('support-ended-other')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('back from a session the platform ended: said', () => {
    show(true);
    expect(screen.getByTestId('support-ended')).toHaveTextContent('Support mode ended.');
  });

  it('every refusal has words in both languages', () => {
    const en = Object.keys(consoleEn.support.enter.refusal).sort();
    expect(Object.keys(consoleHe.support.enter.refusal).sort()).toEqual(en);
    // The action's refusals, and resume's 'none': each one is a key.
    for (const reason of [
      'reason_invalid',
      'forbidden',
      'mfa_required',
      'not_found',
      'system_tenant',
      'active',
      'no_session',
      'not_kept',
      'failed',
      'none',
    ]) {
      expect(en).toContain(reason);
    }
  });
});
