import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The buy action's outcomes, at the refusal.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING HERE CHARGES A CARD
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /billing/credits/buy` moves real money and no automated run may press
 * it. `serverApi` is mocked for this whole file, so the action never reaches
 * the platform.
 *
 * ── WHY THIS FILE DID NOT EXIST AND HAD TO ──
 * Every billing test mocks `buyCreditPack` and hands the component an outcome.
 * So all of them passed while **three of the six outcomes could not be
 * produced by the action at all**: the route answers 402 on a refusal, which
 * throws, and `declined`, `no_billable_entity` and `too_many` were being
 * decided from the body of a 200 that cannot be a failure. The sentence about
 * a declined card - the one this screen most needs - was unreachable, and
 * every refusal fell through to a sentence that told the customer nothing had
 * been charged.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const refuse = (init: ConstructorParameters<typeof ApiError>[0]) =>
  post.mockRejectedValue(new ApiError(init));

/** A 402 as `credits.ts` sends it: the service's return value, verbatim. */
const refusal = (failureCode: string, rest: Record<string, unknown> = {}) =>
  refuse({ kind: 'tenant_inactive', status: 402, failureCode, ...rest });

const buy = async () => {
  const { buyCreditPack } = await import('./actions');
  return buyCreditPack('pack_1000', 1, 'intent_1');
};

beforeEach(() => {
  post.mockReset();
});

describe('★★ the outcomes that could not be reached', () => {
  it('★★ a card that was reached and said no is `declined`', async () => {
    /*
     * `invoiceId` is set on a failure ONLY from `chargeFor`'s result, so its
     * presence is the platform's own record that the charge was attempted.
     * Without it this was indistinguishable from a refusal made before the
     * card was touched - and both said "nothing was charged".
     */
    refusal('card_declined', { invoiceId: 'inv_9' });
    expect(await buy()).toEqual({ ok: false, kind: 'declined', code: 'card_declined' });
  });

  it('★★ the per-pack cap, with the cap itself', async () => {
    refusal('quantity_exceeds_maximum', { failureDetail: { max: 10 } });
    expect(await buy()).toEqual({ ok: false, kind: 'too_many', max: 10 });
  });

  it('★ a cap with no number is still the cap, and says nothing more', async () => {
    // `detail` is per-code and optional. A missing max renders the sentence
    // without one rather than inventing a bound.
    refusal('quantity_exceeds_maximum');
    expect(await buy()).toEqual({ ok: false, kind: 'too_many', max: null });
  });

  it('★★ nothing to bill is its own repair, not a decline', async () => {
    refusal('no_billable_entity');
    expect(await buy()).toEqual({ ok: false, kind: 'no_billable_entity' });
  });

  it('★★ a pack that cannot be bought on this plan will not be bought on a retry', async () => {
    for (const code of [
      'unknown_package',
      'package_inactive',
      'package_not_yet_active',
      'package_expired',
      'package_not_eligible_for_plan',
      'plan_not_eligible_for_packages',
    ]) {
      refusal(code);
      expect(await buy(), code).toEqual({ ok: false, kind: 'not_purchasable' });
    }
  });
});

describe('★★ the unsettled charge, which must never offer a retry', () => {
  it('★★ a 409 is unsettled and now carries the reference', async () => {
    refuse({
      kind: 'conflict',
      status: 409,
      developerMessage: 'payment_outcome_unknown',
      invoiceId: 'inv_7',
    });
    expect(await buy()).toEqual({ ok: false, kind: 'unsettled', invoiceId: 'inv_7' });
  });

  it('★ an unsettled charge with no reference prints no reference', async () => {
    // Not an empty string and not a placeholder: a merchant on the phone is
    // better served by "we cannot show you one" than by a blank that looks
    // like an id.
    refuse({ kind: 'conflict', status: 409, developerMessage: 'payment_outcome_unknown' });
    expect(await buy()).toEqual({ ok: false, kind: 'unsettled', invoiceId: null });
  });

  it('★★ a 409 wins over an invoice id, which would otherwise read as declined', async () => {
    /*
     * ORDER MATTERS AND THIS IS THE ASSERTION THAT HOLDS IT. An unsettled
     * charge has an invoice id too. If the decline branch ran first, the
     * worst outcome on the screen would render as "nothing was charged, you
     * can try again" - and the retry is the harm.
     */
    refuse({ kind: 'conflict', status: 409, invoiceId: 'inv_7', failureCode: 'timeout' });
    expect(await buy()).toMatchObject({ kind: 'unsettled' });
  });
});

describe('★★ what `failed` means now', () => {
  it('★★ an unrecognised refusal does not claim the card was untouched', async () => {
    // It falls through to `failed`, whose sentence says we cannot tell them
    // whether they were charged. The old fallback said they were not.
    refusal('some_code_from_next_year');
    expect(await buy()).toEqual({ ok: false, kind: 'failed' });
  });

  it('★★ a response that fails its contract is `failed`, not `declined`', async () => {
    /*
     * THE CASE THE NEW SENTENCE EXISTS FOR. A contract failure can follow a
     * 200 in which the card WAS charged and the credits granted. Telling that
     * customer nothing was charged is the same harm `unsettled` exists to
     * prevent, arriving through the parse instead of the provider.
     */
    refuse({ kind: 'contract', status: 200, developerMessage: 'Response did not match' });
    expect(await buy()).toEqual({ ok: false, kind: 'failed' });
  });

  it('★ a network failure is `failed` too, for the same reason', async () => {
    post.mockRejectedValue(new Error('offline'));
    expect(await buy()).toEqual({ ok: false, kind: 'failed' });
  });
});

describe('★ the success path', () => {
  it('returns the units and the invoice', async () => {
    post.mockResolvedValue({ success: true, units: 1000, invoiceId: 'inv_1' });
    expect(await buy()).toEqual({ ok: true, units: 1000, invoiceId: 'inv_1' });
  });

  it('★ sends the intent key, which is what makes a double-click one charge', async () => {
    post.mockResolvedValue({ success: true, units: 1000, invoiceId: 'inv_1' });
    await buy();
    expect(post.mock.calls[0]![0].body).toEqual({
      packageKey: 'pack_1000',
      quantity: 1,
      intentKey: 'intent_1',
    });
  });
});
