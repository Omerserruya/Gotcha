import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { couponSchema, tenantCouponSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** One tenant's coupons. The writes are mocked: nothing is sent. */
const { couponActions, refresh } = vi.hoisted(() => ({
  couponActions: { assignTenantCoupon: vi.fn(), revokeTenantCoupon: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./coupon-actions', () => couponActions);
vi.mock('./actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantCoupons } from './TenantCoupons';

const assignment = (id: string, over: object = {}) =>
  tenantCouponSchema.parse({
    id,
    code: `C-${id}`,
    label: '20% off',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2027-09-01T00:00:00.000Z',
    status: 'ACTIVE',
    live: true,
    ...over,
  });
const coupon = (id: string, months: number | null = 12) =>
  couponSchema.parse({
    id,
    code: id.toUpperCase(),
    discountType: 'PERCENT',
    percentOff: 20,
    defaultDurationMonths: months,
    active: true,
    label: '20% off',
  });

const show = (props: Partial<Parameters<typeof TenantCoupons>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: consoleEn }}>
      <TenantCoupons tenantId="t1" coupons={[]} assignable={[coupon('launch')]} {...props} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  couponActions.assignTenantCoupon.mockReset();
  couponActions.revokeTenantCoupon.mockReset();
});

describe('★★ a tenant’s coupons', () => {
  it('★★ unread is said - legacy hid it, which reads as "full price"', () => {
    show({ coupons: undefined });
    expect(screen.getByTestId('tenant-coupons-unread')).toHaveTextContent("couldn't be read");
    expect(screen.queryByText(/full price/)).toBeNull();
  });

  it('★ what is discounting now, and until when', () => {
    show({ coupons: [assignment('a')] });
    expect(screen.getByTestId('tenant-coupons-now')).toHaveTextContent(
      'Discounted by C-a right now, until Sep 1, 2027.',
    );
  });

  it('★ none live: full price', () => {
    show({ coupons: [assignment('a', { live: false, status: 'REVOKED' })] });
    expect(screen.getByTestId('tenant-coupons-now')).toHaveTextContent('Paying full price');
    expect(
      within(screen.getByTestId('assignment-a')).getByTestId('assignment-state'),
    ).toHaveTextContent('Revoked');
  });

  it('★ Revoke only on an ACTIVE assignment, confirmed', async () => {
    couponActions.revokeTenantCoupon.mockResolvedValue({ ok: true });
    show({
      coupons: [assignment('a'), assignment('b', { live: false, status: 'EXPIRED' })],
    });
    expect(within(screen.getByTestId('assignment-b')).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByTestId('revoke-a-open'));
    expect(couponActions.revokeTenantCoupon).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('revoke-a-yes')));
    expect(couponActions.revokeTenantCoupon).toHaveBeenCalledWith('a');
    expect(screen.getByRole('status')).toHaveTextContent('C-a was revoked.');
  });

  it('★ give: chosen coupon, its window said in the confirm, months sent as a number', async () => {
    couponActions.assignTenantCoupon.mockResolvedValue({ ok: true });
    show();
    expect(screen.getByTestId('give-coupon-open')).toBeDisabled();
    fireEvent.change(screen.getByTestId('give-coupon-select'), { target: { value: 'launch' } });
    fireEvent.click(screen.getByTestId('give-coupon-open'));
    expect(screen.getByRole('group', { name: 'Give the coupon' })).toHaveTextContent(
      'LAUNCH discounts every charge from today for 12 months.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByTestId('give-coupon-months'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('give-coupon-open'));
    await act(async () => fireEvent.click(screen.getByTestId('give-coupon-yes')));
    expect(couponActions.assignTenantCoupon).toHaveBeenCalledWith('t1', 'launch', 3);
  });

  it('no months typed: null, the coupon’s own window', async () => {
    couponActions.assignTenantCoupon.mockResolvedValue({ ok: true });
    show({ assignable: [coupon('open', null)] });
    fireEvent.change(screen.getByTestId('give-coupon-select'), { target: { value: 'open' } });
    fireEvent.click(screen.getByTestId('give-coupon-open'));
    expect(screen.getByRole('group', { name: 'Give the coupon' })).toHaveTextContent(
      'until it is revoked',
    );
    await act(async () => fireEvent.click(screen.getByTestId('give-coupon-yes')));
    expect(couponActions.assignTenantCoupon).toHaveBeenCalledWith('t1', 'open', null);
  });

  it('★ months that are not a whole number of at least 1: cannot give', () => {
    show();
    fireEvent.change(screen.getByTestId('give-coupon-select'), { target: { value: 'launch' } });
    for (const bad of ['0', '1.5', 'abc']) {
      fireEvent.change(screen.getByTestId('give-coupon-months'), { target: { value: bad } });
      expect(screen.getByTestId('give-coupon-open')).toBeDisabled();
    }
  });

  it('★ the route’s refusal in words', async () => {
    couponActions.assignTenantCoupon.mockResolvedValue({ ok: false, reason: 'already_assigned' });
    show();
    fireEvent.change(screen.getByTestId('give-coupon-select'), { target: { value: 'launch' } });
    fireEvent.click(screen.getByTestId('give-coupon-open'));
    await act(async () => fireEvent.click(screen.getByTestId('give-coupon-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This organization already has this coupon. Revoke that one first.',
    );
  });

  it('nothing to give, or the list unread: two sentences', () => {
    const { unmount } = show({ assignable: [] });
    expect(screen.getByTestId('assignable-none')).toBeInTheDocument();
    unmount();
    show({ assignable: undefined });
    expect(screen.getByTestId('assignable-unread')).toBeInTheDocument();
  });
});
