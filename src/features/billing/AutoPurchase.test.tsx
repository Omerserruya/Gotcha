import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { autoPurchaseSchema } from '@/api/contracts/auto-purchase';
import messages from '@/i18n/messages/en/billing.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));

import { AutoPurchase, optionOf } from './AutoPurchase';

const policy = (over: Record<string, unknown> = {}) => autoPurchaseSchema.parse(over);

describe('★ 17c — the stored answer is the marked card', () => {
  it.each([
    [{ enabled: true }, 'pack'],
    [{ enabled: false, limitBehavior: 'PAYG' }, 'payg'],
    [{ enabled: false, limitBehavior: 'STOP_AI' }, 'stop'],
    [{ enabled: false, limitBehavior: 'HUMAN_ONLY' }, 'stop'],
  ])('%o → %s', async (over, option) => {
    expect(optionOf(policy(over))).toBe(option);
    render(await AutoPurchase({ policy: policy(over), currency: 'USD' }));
    for (const key of ['pack', 'payg', 'stop']) {
      expect(screen.getByTestId(`auto-option-${key}`)).toHaveAttribute(
        'data-current',
        key === option ? 'yes' : 'no',
      );
    }
  });
});

describe('★ 17c — alerts: what is stored, and "—" for what nothing sends', () => {
  it('the warning threshold is on with the purchase; 02’s other two are "—"', async () => {
    render(
      await AutoPurchase({
        policy: policy({ enabled: true, warningThresholdPct: 80 }),
        currency: 'USD',
      }),
    );
    expect(screen.getByTestId('auto-warning')).toHaveTextContent(/80%.*before anything is bought/);
    expect(screen.getByText('Every automatic purchase').closest('li')).toHaveTextContent('—');
    expect(screen.getByText('When the monthly limit is hit').closest('li')).toHaveAttribute(
      'title',
      'Nothing sends this alert yet.',
    );
  });

  it('a pay-as-you-go rate is per credit, said only when the platform sends one', async () => {
    const { unmount } = render(
      await AutoPurchase({
        policy: policy({ limitBehavior: 'PAYG' }),
        currency: 'USD',
        paygRate: '0.065',
      }),
    );
    expect(screen.getByTestId('auto-payg-rate')).toHaveTextContent('0.065 USD per credit');
    unmount();
    render(await AutoPurchase({ policy: policy(), currency: 'USD' }));
    expect(screen.queryByTestId('auto-payg-rate')).toBeNull();
  });

  it('nothing configured says what the default does', async () => {
    render(await AutoPurchase({ policy: null, currency: 'USD' }));
    expect(screen.getByTestId('auto-purchase-unset')).toHaveTextContent(/stops answering/);
  });
});
