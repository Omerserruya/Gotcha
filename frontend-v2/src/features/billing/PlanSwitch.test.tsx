import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

/* A plan change charges the stored card: both actions are spies, always. */
const previewPlanChange = vi.hoisted(() => vi.fn());
const changePlanTo = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ previewPlanChange, changePlanTo }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { PlanSwitch } from './PlanSwitch';

const preview = (over: Record<string, unknown> = {}) => ({
  applied: 'immediate',
  chargeNow: {
    gross: '130.24',
    net: '110.37',
    tax: '19.87',
    taxPercent: '18',
    chargeCurrency: 'ILS',
    vatIncluded: true,
    fxRateVersion: 7,
  },
  refused: null,
  hasPaymentMethod: true,
  effectiveAt: '2026-10-08T00:00:00Z',
  newMonthly: { amount: '1499', currency: 'USD' },
  ...over,
});

beforeEach(() => {
  previewPlanChange.mockReset();
  changePlanTo.mockReset();
  refresh.mockReset();
});
const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }} timeZone="UTC">
      <PlanSwitch planKey="ai_voice" planName="AI Voice" label="Switch to AI Voice" />
    </NextIntlClientProvider>,
  );
const open = async () => {
  show();
  await userEvent.click(screen.getByTestId('switch-button'));
};

describe('★★ 17b live - the server’s exact figure, and only that figure is charged', () => {
  it('the gross that leaves the card, its VAT, then the monthly price; nothing charged before Yes', async () => {
    previewPlanChange.mockResolvedValue({ ok: true, preview: preview() });
    await open();
    expect(previewPlanChange).toHaveBeenCalledWith('ai_voice');
    const box = screen.getByTestId('switch-button-confirm');
    expect(box).toHaveTextContent('charges ₪130.24 now, including VAT (₪19.87)');
    expect(box).toHaveTextContent('Then $1,499.00 a month.');
    expect(screen.getByTestId('switch-button-yes')).toHaveTextContent('Yes, charge ₪130.24');
    expect(changePlanTo).not.toHaveBeenCalled();
  });

  it('Yes sends that figure and its rate version back - and says it is done', async () => {
    previewPlanChange.mockResolvedValue({ ok: true, preview: preview() });
    changePlanTo.mockResolvedValue({ ok: true, applied: 'immediate', effectiveAt: null });
    await open();
    await userEvent.click(screen.getByTestId('switch-button-yes'));
    expect(changePlanTo).toHaveBeenCalledWith('ai_voice', { gross: '130.24', fxRateVersion: 7 });
    expect(screen.getByTestId('switch-done')).toHaveTextContent("You're on AI Voice now.");
    expect(refresh).toHaveBeenCalled();
  });

  it('★★ the figure moved (409): nothing charged - the NEW figure re-shown and asked again', async () => {
    previewPlanChange
      .mockResolvedValueOnce({ ok: true, preview: preview() })
      .mockResolvedValueOnce({
        ok: true,
        preview: preview({
          chargeNow: { ...preview().chargeNow, gross: '131.10', fxRateVersion: 8 },
        }),
      });
    changePlanTo.mockResolvedValueOnce({ ok: false, reason: 'moved' });
    await open();
    await userEvent.click(screen.getByTestId('switch-button-yes'));
    expect(screen.getByTestId('switch-moved')).toHaveTextContent(
      'The amount changed since you looked',
    );
    expect(screen.getByTestId('switch-button-yes')).toHaveTextContent('Yes, charge ₪131.10');
    expect(changePlanTo).toHaveBeenCalledTimes(1);
  });

  it('★★ an outcome not known: said so, and NO way to try again', async () => {
    previewPlanChange.mockResolvedValue({ ok: true, preview: preview() });
    changePlanTo.mockResolvedValue({ ok: false, reason: 'unknown' });
    await open();
    await userEvent.click(screen.getByTestId('switch-button-yes'));
    expect(screen.getByTestId('switch-problem')).toHaveTextContent(
      "We couldn't confirm whether the charge went through. Don't try again",
    );
    expect(screen.queryByTestId('switch-retry')).toBeNull();
  });

  it('a declined card: nothing charged, still on the current plan - and may be tried again', async () => {
    previewPlanChange.mockResolvedValue({ ok: true, preview: preview() });
    changePlanTo.mockResolvedValue({ ok: false, reason: 'declined' });
    await open();
    await userEvent.click(screen.getByTestId('switch-button-yes'));
    expect(screen.getByTestId('switch-problem')).toHaveTextContent('Nothing was charged');
    expect(screen.getByTestId('switch-retry')).toBeInTheDocument();
  });

  it('no card on file: said, and no Yes', async () => {
    previewPlanChange.mockResolvedValue({
      ok: true,
      preview: preview({ hasPaymentMethod: false }),
    });
    await open();
    expect(screen.getByTestId('switch-button-confirm')).toHaveTextContent(
      "there's no card on file",
    );
    expect(screen.queryByTestId('switch-button-yes')).toBeNull();
  });

  it('refused by tax (no billing country): said, and no Yes', async () => {
    previewPlanChange.mockResolvedValue({
      ok: true,
      preview: preview({
        chargeNow: null,
        refused: { code: 'charge_not_taxable', reason: 'tax_country_undeclared' },
      }),
    });
    await open();
    expect(screen.getByTestId('switch-button-confirm')).toHaveTextContent(
      'without your billing country',
    );
    expect(screen.queryByTestId('switch-button-yes')).toBeNull();
  });

  it('a move down: nothing charged now, the date it happens; Yes sends no figure', async () => {
    previewPlanChange.mockResolvedValue({
      ok: true,
      preview: preview({
        applied: 'scheduled',
        chargeNow: null,
        effectiveAt: '2027-09-08T00:00:00Z',
      }),
    });
    changePlanTo.mockResolvedValue({
      ok: true,
      applied: 'scheduled',
      effectiveAt: '2027-09-08T00:00:00Z',
    });
    await open();
    expect(screen.getByTestId('switch-button-confirm')).toHaveTextContent(
      'Nothing is charged now. You move to AI Voice on September 8, 2027.',
    );
    await userEvent.click(screen.getByTestId('switch-button-yes'));
    expect(changePlanTo).toHaveBeenCalledWith('ai_voice', { gross: null, fxRateVersion: null });
    expect(screen.getByTestId('switch-done')).toHaveTextContent(
      'Done: you move to AI Voice on September 8, 2027.',
    );
  });
});
