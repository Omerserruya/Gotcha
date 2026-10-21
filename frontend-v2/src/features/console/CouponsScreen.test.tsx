import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { couponSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** Console · Coupons. The writes are mocked: nothing is sent. */
const { couponActions, refresh } = vi.hoisted(() => ({
  couponActions: {
    createCoupon: vi.fn(),
    setCouponActive: vi.fn(),
    assignTenantCoupon: vi.fn(),
    revokeTenantCoupon: vi.fn(),
  },
  refresh: vi.fn(),
}));
vi.mock('./coupon-actions', () => couponActions);
vi.mock('./actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { CouponsScreen } from './CouponsScreen';

const coupon = (id: string, over: object = {}) =>
  couponSchema.parse({
    id,
    code: id.toUpperCase(),
    nameEn: 'Launch',
    discountType: 'PERCENT',
    percentOff: 20,
    defaultDurationMonths: 12,
    active: true,
    maxRedemptions: null,
    assignmentCount: 1,
    label: '20% off',
    ...over,
  });

const show = (...args: [Parameters<typeof CouponsScreen>[0]['coupons']?]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <CouponsScreen coupons={args.length === 0 ? [] : args[0]} />
    </NextIntlClientProvider>,
  );

const field = (name: string) => screen.getByLabelText(name);

beforeEach(() => {
  for (const action of Object.values(couponActions)) action.mockReset();
  refresh.mockClear();
});

describe('★★ the issued coupons', () => {
  it('★ each: code, discount, default window, how many it was given to, state', () => {
    show([
      coupon('a'),
      coupon('b', {
        defaultDurationMonths: null,
        maxRedemptions: 5,
        assignmentCount: 2,
        active: false,
      }),
    ]);
    const a = screen.getByTestId('coupon-a');
    expect(a).toHaveTextContent('20% off');
    expect(a).toHaveTextContent('12 months by default');
    expect(within(a).getByTestId('coupon-given')).toHaveTextContent('Given to 1 organization');
    expect(within(a).getByTestId('coupon-state')).toHaveTextContent('Active');
    const b = screen.getByTestId('coupon-b');
    expect(b).toHaveTextContent('Until revoked');
    expect(within(b).getByTestId('coupon-given')).toHaveTextContent('Given to 2 of at most 5');
    expect(within(b).getByTestId('coupon-state')).toHaveTextContent('Disabled');
  });

  it('★★ disabling says it stops discounting everywhere, and waits for the route', async () => {
    couponActions.setCouponActive.mockResolvedValue({ ok: true });
    show([coupon('a')]);
    fireEvent.click(screen.getByTestId('coupon-active-a-open'));
    expect(screen.getByRole('group', { name: 'Disable' })).toHaveTextContent(
      'stops discounting at once, for every organization',
    );
    await act(async () => fireEvent.click(screen.getByTestId('coupon-active-a-yes')));
    expect(couponActions.setCouponActive).toHaveBeenCalledWith('a', false);
    expect(screen.getByRole('status')).toHaveTextContent('A is disabled.');
  });

  it('a disabled one is enabled', async () => {
    couponActions.setCouponActive.mockResolvedValue({ ok: false, reason: 'held' });
    show([coupon('b', { active: false })]);
    fireEvent.click(screen.getByTestId('coupon-active-b-open'));
    await act(async () => fireEvent.click(screen.getByTestId('coupon-active-b-yes')));
    expect(couponActions.setCouponActive).toHaveBeenCalledWith('b', true);
    expect(screen.getByRole('alert')).toHaveTextContent('Billing writes are off');
  });

  it('★ unread and none are two sentences', () => {
    const { unmount } = show(undefined);
    expect(screen.getByTestId('coupons-unread')).toBeInTheDocument();
    unmount();
    show([]);
    expect(screen.getByTestId('coupons-empty')).toBeInTheDocument();
  });
});

describe('★★ creating a coupon', () => {
  it('★ the worked example turns the percentage into money', () => {
    show();
    expect(screen.getByTestId('coupon-example')).toHaveTextContent(
      /On a plan of ₪499(\.00)? a month: ₪499(\.00)? becomes ₪399\.20 \(₪99\.80 off\), every month for 12 months\./,
    );
    fireEvent.change(field('Default months'), { target: { value: '' } });
    expect(screen.getByTestId('coupon-example')).toHaveTextContent(
      'every month until it is revoked',
    );
  });

  it('★ a fixed amount in another currency only says what it applies to', () => {
    show();
    fireEvent.change(screen.getByTestId('coupon-type'), { target: { value: 'FIXED' } });
    fireEvent.change(screen.getByTestId('coupon-currency'), { target: { value: 'USD' } });
    expect(screen.getByTestId('coupon-example')).toHaveTextContent(
      'A USD coupon only discounts charges made in USD.',
    );
  });

  it('★★ needs a code and a name; months and limit must be whole numbers', () => {
    show();
    const submit = screen.getByTestId('coupon-create-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(field('Name in English'), { target: { value: 'Launch' } });
    expect(submit).toBeDisabled();
    fireEvent.change(field('Code'), { target: { value: 'launch20' } });
    expect(submit).toBeEnabled();
    fireEvent.change(field('Name in English'), { target: { value: '  ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(field('Name in English'), { target: { value: 'Launch' } });
    fireEvent.change(field('Default months'), { target: { value: '1.5' } });
    expect(submit).toBeDisabled();
    fireEvent.change(field('Default months'), { target: { value: '6' } });
    fireEvent.change(field('At most this many organizations'), { target: { value: '0' } });
    expect(submit).toBeDisabled();
  });

  it('★ sends what the service takes - the code upper-cased, a percent, no amount', async () => {
    couponActions.createCoupon.mockResolvedValue({ ok: true });
    show();
    fireEvent.change(field('Code'), { target: { value: 'launch20' } });
    fireEvent.change(field('Name in English'), { target: { value: ' Launch ' } });
    await act(async () => fireEvent.click(screen.getByTestId('coupon-create-submit')));
    expect(couponActions.createCoupon).toHaveBeenCalledWith({
      code: 'LAUNCH20',
      nameEn: 'Launch',
      nameHe: null,
      discountType: 'PERCENT',
      percentOff: 20,
      amountOff: null,
      currency: null,
      defaultDurationMonths: 12,
      maxRedemptions: null,
      internalNote: null,
    });
    expect(screen.getByTestId('coupon-create-outcome')).toHaveTextContent(
      'It discounts nothing until it is given to an organization.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('a fixed amount sends the amount and the currency, no percent', async () => {
    couponActions.createCoupon.mockResolvedValue({ ok: true });
    show();
    fireEvent.change(field('Code'), { target: { value: 'FIFTY' } });
    fireEvent.change(field('Name in English'), { target: { value: 'Fifty off' } });
    fireEvent.change(screen.getByTestId('coupon-type'), { target: { value: 'FIXED' } });
    await act(async () => fireEvent.click(screen.getByTestId('coupon-create-submit')));
    expect(couponActions.createCoupon.mock.calls[0]![0]).toMatchObject({
      discountType: 'FIXED',
      percentOff: null,
      amountOff: '50.00',
      currency: 'ILS',
    });
  });

  it('★ the route’s refusal in words', async () => {
    couponActions.createCoupon.mockResolvedValue({ ok: false, reason: 'invalid_code' });
    show();
    fireEvent.change(field('Code'), { target: { value: 'X' } });
    fireEvent.change(field('Name in English'), { target: { value: 'X' } });
    await act(async () => fireEvent.click(screen.getByTestId('coupon-create-submit')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A code is 2 to 32 letters, digits, dashes or underscores.',
    );
  });
});
