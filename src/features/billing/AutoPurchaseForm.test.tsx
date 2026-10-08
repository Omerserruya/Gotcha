import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';

/* Saving arms real charges: the action is a spy, always. */
const saveAutoPurchase = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ saveAutoPurchase }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  saveAutoPurchase.mockReset();
  refresh.mockReset();
});

import { AUTO_PURCHASE_FORM_ID } from './auto-purchase-form';
import { AutoPurchaseForm } from './AutoPurchaseForm';

const PACKS = [
  { key: 'p1000', name: '1,000 credits', price: '₪290' },
  { key: 'p5000', name: '5,000 credits', price: '₪1,200' },
];

/* With the overlay's footer Save outside the form, submitting it by id - as on the page. */
const show = (over: Partial<Parameters<typeof AutoPurchaseForm>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <AutoPurchaseForm
        initialOption="stop"
        initialThreshold={10}
        initialCap={null}
        initialBehavior="STOP_AI"
        packs={PACKS}
        currency="ILS"
        card="Visa ending 4417"
        current={{ pack: null, payg: null, stop: null }}
        heldTag="Not available here"
        heldWhy="Billing in this environment uses the live payment account."
        {...over}
      />
      <button type="submit" form={AUTO_PURCHASE_FORM_ID} data-testid="footer-save">
        Save
      </button>
    </NextIntlClientProvider>,
  );

describe('★★ 17c auto-purchase - chosen, said in full, and held (it arms real charges)', () => {
  it('a pack: what it buys, when, on which card, the limit and what happens at zero; Yes is a status', async () => {
    show();
    await userEvent.click(screen.getByTestId('auto-choose-pack'));
    await userEvent.selectOptions(screen.getByTestId('auto-pack'), 'p5000');
    await userEvent.clear(screen.getByTestId('auto-threshold'));
    await userEvent.type(screen.getByTestId('auto-threshold'), '15');
    await userEvent.type(screen.getByTestId('auto-cap-input'), '2400');
    await userEvent.selectOptions(screen.getByTestId('auto-behavior-choice'), 'HUMAN_ONLY');
    await userEvent.click(screen.getByTestId('footer-save'));
    const box = screen.getByTestId('auto-confirm');
    expect(box).toHaveTextContent(
      'This buys 5,000 credits (₪1,200) automatically each time credit drops to 15%, charged to Visa ending 4417.',
    );
    expect(box).toHaveTextContent('At most 2400 ILS a month on automatic purchases.');
    expect(box).toHaveTextContent(
      'When it runs out: the AI stops and your team carries on as normal.',
    );
    const yes = screen.getByTestId('auto-yes');
    expect(yes.tagName).toBe('SPAN');
    expect(yes).toHaveAttribute('aria-disabled', 'true');
    expect(yes).toHaveTextContent('Not available here');
  });

  it('no limit is said as no limit - every time', async () => {
    show({ initialOption: 'pack' });
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(screen.getByTestId('auto-confirm')).toHaveTextContent(
      "There's no monthly limit - it buys every time credit drops that low.",
    );
  });

  it('no card: every purchase would fail - said instead of a confirm', async () => {
    show({ initialOption: 'pack', card: null });
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(screen.queryByTestId('auto-confirm')).toBeNull();
    expect(screen.getByTestId('auto-problem')).toHaveTextContent(
      "There's no card on file, so every automatic purchase would fail",
    );
  });

  it.each([
    ['0', 'The level must be a whole number from 1 to 100.'],
    ['101', 'The level must be a whole number from 1 to 100.'],
    ['7.5', 'The level must be a whole number from 1 to 100.'],
  ])('a level of %s is refused in words', async (level, words) => {
    show({ initialOption: 'pack' });
    await userEvent.clear(screen.getByTestId('auto-threshold'));
    await userEvent.type(screen.getByTestId('auto-threshold'), level);
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(screen.getByTestId('auto-problem')).toHaveTextContent(words);
  });

  it('a limit that is not an amount above zero is refused', async () => {
    show({ initialOption: 'pack' });
    await userEvent.type(screen.getByTestId('auto-cap-input'), '-5');
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(screen.getByTestId('auto-problem')).toHaveTextContent(
      'The monthly limit must be an amount above zero',
    );
  });

  it('stop: nothing bought; the rule at zero said', async () => {
    show();
    await userEvent.click(screen.getByTestId('footer-save'));
    const box = screen.getByTestId('auto-confirm');
    expect(box).toHaveTextContent('Nothing is bought automatically.');
    expect(box).toHaveTextContent('When it runs out: the AI stops answering.');
  });

  it('pay-as-you-go is shown and cannot be chosen - the setter refuses it', () => {
    show();
    expect(screen.getByTestId('auto-choose-payg')).toBeDisabled();
    expect(screen.getByTestId('auto-option-payg')).toHaveAttribute(
      'title',
      "Pay-as-you-go is set up by GOTCHA for you and can't be chosen here.",
    );
    // Only the four the setter accepts are offered for "at zero".
    const offered = [...screen.getByTestId('auto-behavior-choice').querySelectorAll('option')];
    expect(offered.map((o) => o.value)).toEqual([
      'STOP_AI',
      'HUMAN_ONLY',
      'REQUIRE_APPROVAL',
      'PREPAID_ONLY',
    ]);
  });
});

describe('★★ live (BILLING_WRITES=on): Yes saves - and sends back what the form does not show', () => {
  const STORED = {
    packageKey: 'p5000',
    warningThresholdPct: 70,
    incrementCredits: 500,
    pricePerCredit: '0.012000',
  };

  it('the stored pack is preselected; Yes sends every field, the untouched ones as stored', async () => {
    saveAutoPurchase.mockResolvedValue({ ok: true });
    show({ initialOption: 'pack', live: true, stored: STORED });
    expect(screen.getByTestId('auto-pack')).toHaveValue('p5000');
    await userEvent.type(screen.getByTestId('auto-cap-input'), '2400');
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(saveAutoPurchase).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('auto-yes'));
    expect(saveAutoPurchase).toHaveBeenCalledWith({
      enabled: true,
      thresholdPct: 10,
      packageKey: 'p5000',
      maxMonthlySpend: '2400',
      limitBehavior: 'STOP_AI',
      warningThresholdPct: 70,
      incrementCredits: 500,
      pricePerCredit: '0.012000',
    });
    expect(screen.getByTestId('auto-saved')).toHaveTextContent('Saved.');
    expect(refresh).toHaveBeenCalled();
  });

  it('stop: off, no limit, the stored pack kept rather than cleared', async () => {
    saveAutoPurchase.mockResolvedValue({ ok: true });
    show({ live: true, stored: STORED });
    await userEvent.click(screen.getByTestId('footer-save'));
    await userEvent.click(screen.getByTestId('auto-yes'));
    expect(saveAutoPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, packageKey: 'p5000', maxMonthlySpend: null }),
    );
  });

  it('a plan without automatic purchases (402) is said; nothing claims it saved', async () => {
    saveAutoPurchase.mockResolvedValue({ ok: false, reason: 'plan' });
    show({ initialOption: 'pack', live: true });
    await userEvent.click(screen.getByTestId('footer-save'));
    await userEvent.click(screen.getByTestId('auto-yes'));
    expect(screen.getByTestId('auto-refused')).toHaveTextContent(
      "Your plan doesn't include automatic purchases",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
