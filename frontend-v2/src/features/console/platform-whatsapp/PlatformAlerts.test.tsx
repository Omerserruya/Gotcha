import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformTemplate } from '@/api/contracts/platform-whatsapp';
import consoleEn from '@/i18n/messages/en/console.json';

/* ⚠ Mocked - a switch decides whether real alerts go out. */
const { actions, refresh } = vi.hoisted(() => ({
  actions: { setPlatformAlert: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./platform-whatsapp-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { allEight, template } from './fixtures';
import { PlatformAlerts } from './PlatformAlerts';

const w = consoleEn.platformWhatsApp;
const show = (templates: readonly PlatformTemplate[], canSend = true, hasNumber = true) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <PlatformAlerts templates={templates} canSend={canSend} hasNumber={hasNumber} />
    </NextIntlClientProvider>,
  );
const sw = (name = 'gotcha_customer_waiting') => screen.getByTestId(`alert-${name}-switch`);

beforeEach(() => {
  actions.setPlatformAlert.mockReset();
  actions.setPlatformAlert.mockResolvedValue({ ok: true });
  refresh.mockClear();
});

describe('★★ which alerts go out on WhatsApp', () => {
  it('★★ a switch for each toggleable alert only; the two that follow another say so', () => {
    show(allEight());
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(screen.queryByTestId('alert-gotcha_verification_code-switch')).toBeNull();
    expect(screen.getByTestId('alert-gotcha_approval_required')).toHaveTextContent(
      w.alerts.rides.gotcha_approval_required,
    );
  });

  it('★★ off and not approved: held, with why', () => {
    show([template({ canEnable: false })]);
    expect(sw()).toBeDisabled();
    expect(screen.getByTestId('alert-gotcha_customer_waiting-why')).toHaveTextContent(
      w.alerts.needsApproval,
    );
  });

  it('★★ with no number, the why is the number, not the approval', () => {
    show([template({ canEnable: false })], false, false);
    expect(screen.getByTestId('alert-gotcha_customer_waiting-why')).toHaveTextContent(
      w.alerts.needsNumber,
    );
  });

  it('★★ allowed: turns on, and the page reads again', async () => {
    show([template({ canEnable: true })]);
    expect(sw()).toHaveAttribute('aria-checked', 'false');
    await act(async () => fireEvent.click(sw()));
    expect(actions.setPlatformAlert).toHaveBeenCalledWith('conversation.waiting', true);
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    expect(refresh).toHaveBeenCalled();
  });

  it('★★ a refusal puts it back and says why', async () => {
    actions.setPlatformAlert.mockResolvedValue({ ok: false, reason: 'template_not_approved' });
    show([template({ canEnable: true })]);
    await act(async () => fireEvent.click(sw()));
    expect(sw()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('alert-gotcha_customer_waiting-refused')).toHaveTextContent(
      w.refusal.template_not_approved,
    );
  });

  it('★★ on can always be turned off, even when it could not be turned on again', async () => {
    show([template({ alertEnabled: true, canEnable: false })]);
    expect(sw()).not.toBeDisabled();
    await act(async () => fireEvent.click(sw()));
    expect(actions.setPlatformAlert).toHaveBeenCalledWith('conversation.waiting', false);
  });

  it('★ on while nothing sends: kept, and said', () => {
    show([template({ alertEnabled: true, canEnable: false })], false, true);
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('alert-gotcha_customer_waiting-why')).toHaveTextContent(
      w.alerts.stopped,
    );
  });

  it('★ the switch is named for the reader', () => {
    show([template({ canEnable: true })]);
    expect(sw()).toHaveAccessibleName('A customer is waiting on WhatsApp');
  });
});
