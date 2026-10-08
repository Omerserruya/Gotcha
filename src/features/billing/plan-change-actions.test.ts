import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ change-plan charges the stored card - mocked for this whole file. */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
const writes = vi.hoisted(() => ({ on: true }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));

import { changePlanTo, previewPlanChange } from './actions';

const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);
const refuse = (status: number, developerMessage?: string) =>
  post.mockRejectedValueOnce(
    new ApiError({ kind: status === 409 ? 'conflict' : 'validation', status, developerMessage }),
  );
const EXPECTED = { gross: '130.24', fxRateVersion: 7 };

beforeEach(() => {
  post.mockReset();
  writes.on = true;
});

describe('★★ billing writes off: preview and change refuse before any request', () => {
  it('both held; nothing posted', async () => {
    writes.on = false;
    expect(await previewPlanChange('ai_voice')).toEqual({ ok: false, reason: 'held' });
    expect(await changePlanTo('ai_voice', EXPECTED)).toEqual({ ok: false, reason: 'held' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★★ the change sends back the confirmed figure, always', () => {
  it('expectedChargeAmount and expectedFxRateVersion in the body - null when nothing is charged', async () => {
    post.mockImplementation(answering({ ok: true, applied: 'immediate' }));
    await changePlanTo('ai_voice', EXPECTED);
    await changePlanTo('foundation', { gross: null, fxRateVersion: null });
    expect(post.mock.calls.map((c) => (c[0] as { body: unknown }).body)).toEqual([
      { planKey: 'ai_voice', expectedChargeAmount: '130.24', expectedFxRateVersion: 7 },
      { planKey: 'foundation', expectedChargeAmount: null, expectedFxRateVersion: null },
    ]);
  });

  it('the preview reads the server’s exact figure (a bare { ok, preview })', async () => {
    post.mockImplementation(
      answering({
        ok: true,
        preview: {
          applied: 'immediate',
          chargeNow: {
            gross: '130.24',
            net: '110.37',
            tax: '19.87',
            chargeCurrency: 'ILS',
            fxRateVersion: 7,
          },
          refused: null,
          hasPaymentMethod: true,
          effectiveAt: '2026-10-08T00:00:00Z',
          newMonthly: { amount: 1499, currency: 'USD' },
        },
      }),
    );
    const answer = await previewPlanChange('ai_voice');
    expect(answer.ok && answer.preview.chargeNow).toMatchObject({
      gross: '130.24',
      fxRateVersion: 7,
    });
    expect(answer.ok && answer.preview.newMonthly).toEqual({ amount: '1499', currency: 'USD' });
  });
});

describe('★★ every refusal by what it means for the money', () => {
  it.each([
    [409, 'charge_amount_changed', 'moved'],
    [400, 'upgrade_payment_outcome_unknown', 'unknown'],
    [400, 'payment_method_required', 'no_card'],
    [400, 'upgrade_payment_failed:card_declined', 'declined'],
    [400, 'plan_not_available', 'not_selectable'],
    [500, undefined, 'unknown'],
  ])('%s %s → %s', async (status, message, reason) => {
    refuse(status, message);
    expect(await changePlanTo('ai_voice', EXPECTED)).toEqual({ ok: false, reason });
  });

  it('no answer at all is `unknown` - it may have charged', async () => {
    post.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await changePlanTo('ai_voice', EXPECTED)).toEqual({ ok: false, reason: 'unknown' });
  });
});
