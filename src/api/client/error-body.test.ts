import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { billingEndpoints } from '@/api/endpoints/registry';

import { ApiError } from './api-error';
import { HttpClient } from './http-client';

/**
 * What survives a refusal, through the real client.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DEFECT: ONE REQUIRED FIELD DISCARDED THE WHOLE BODY
 * ════════════════════════════════════════════════════════════════════════════
 * `errorEnvelopeSchema.error` was `z.string()` — required. A refusal without
 * an `error` key failed `safeParse`, and `readErrorBody` answers `{}` on a
 * failed parse, so **every other field went with it**: the code, the detail,
 * the invoice id. Not one field missing, all of them.
 *
 * `POST /billing/credits/buy` refuses with exactly such a body. So on the one
 * screen that charges a card, the reason for every refusal was thrown away in
 * the client and the screen said "the payment didn't go through, and nothing
 * was charged" to everybody, including people whose card had been reached.
 *
 * Driven through `HttpClient` against a stubbed `fetch` rather than by
 * constructing `ApiError` by hand: an assertion on a hand-built error would
 * have passed on the broken code, because the break was in the parse.
 */

const client = new HttpClient({ baseUrl: '', defaultTimeoutMs: 1_000 });

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

const buy = () =>
  client.post({ endpoint: billingEndpoints.creditsBuy(), payload: z.unknown(), body: {} });

afterEach(() => vi.unstubAllGlobals());

describe('★★ a refusal with no `error` key keeps everything else', () => {
  it('★★ carries failureCode, its detail, and the invoice id', async () => {
    /*
     * The real 402 from `credits.ts`: `res.status(402).json(result)`, where
     * `result` is `buyCredits`' return value. No `error`. No `code`.
     */
    respond(402, {
      success: false,
      failureCode: 'quantity_exceeds_maximum',
      detail: { max: 10 },
    });

    const error = await buy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;

    expect(api.failureCode).toBe('quantity_exceeds_maximum');
    expect(api.failureDetail?.max).toBe(10);
    // And `code` stays undefined, which is the point: matching on it here —
    // the idiom every other action uses — could never have fired.
    expect(api.code).toBeUndefined();
  });

  it('★★ an invoice id on a refusal means the card was reached', async () => {
    // `buyCredits` sets it only from `chargeFor`'s result; every refusal
    // before the charge returns without one.
    respond(402, { success: false, invoiceId: 'inv_9', failureCode: 'card_declined' });

    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.invoiceId).toBe('inv_9');
  });

  it('★★ the 409 carries the reference a merchant can quote', async () => {
    /*
     * The unsettled charge. The route sends `{ ...result, error:
     * "payment_outcome_unknown" }`, so this one DID parse before — but
     * `invoiceId` was not a field on the envelope, and `z.object` strips what
     * it is not told about. The screen had to say "check your invoices" with
     * nothing to check for.
     */
    respond(409, {
      success: false,
      outcomeUnknown: true,
      invoiceId: 'inv_7',
      error: 'payment_outcome_unknown',
    });

    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.invoiceId).toBe('inv_7');
    expect(api.developerMessage).toBe('payment_outcome_unknown');
  });

  it('★ the fields that already worked still work', async () => {
    // The entitlement envelope, which is where `code` comes from and why the
    // idiom exists at all.
    respond(402, {
      error: 'Plan does not include this',
      code: 'PLAN_FEATURE_REQUIRED',
      checkoutPath: '/settings/billing/plan',
    });

    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(api.checkoutPath).toBe('/settings/billing/plan');
    expect(api.developerMessage).toBe('Plan does not include this');
  });

  it('★ a body that is not an envelope at all still produces a usable error', async () => {
    // Making `error` optional means almost anything parses. That is fine —
    // every field is optional, so the result is an ApiError with a status and
    // no claims, which is what an unrecognised body should produce.
    respond(500, { nothing: 'recognisable' });

    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.kind).toBe('server');
    expect(api.failureCode).toBeUndefined();
    expect(api.developerMessage).toBeUndefined();
  });
});

describe('★★ the entitlement gate’s own fields survive the envelope', () => {
  it('★★ keeps `upgradePath`, `feature`, `currentPlan` — none of which were declared', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * TWO DIFFERENT 402s SHARE THIS ENVELOPE AND DO NOT SHARE FIELD NAMES
     * ════════════════════════════════════════════════════════════════════════
     * The tenant gate sends `checkoutPath`. `EntitlementDeniedError` — the
     * feature-level refusal in `packages/shared` — sends **`upgradePath`**, plus
     * `feature` and `currentPlan`. Only the first was declared, so `z.object`
     * stripped the rest and the panel had nothing to say and nowhere to point.
     *
     * The exact body from `entitlementErrorResponse`.
     */
    respond(402, {
      code: 'PLAN_FEATURE_REQUIRED',
      feature: 'ai.copilot',
      currentPlan: 'foundation',
      upgradePath: '/settings/billing/plan',
    });

    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(api.feature).toBe('ai.copilot');
    expect(api.currentPlan).toBe('foundation');
    expect(api.upgradePath).toBe('/settings/billing/plan');
    // And it is NOT the tenant gate's field, which is the distinction that was
    // being lost.
    expect(api.checkoutPath).toBeUndefined();
  });

  it('★★ keeps the numbers on a limit breach', async () => {
    respond(402, { code: 'PLAN_LIMIT_REACHED', feature: 'ai.employee', limit: 3, current: 3 });
    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.limit).toBe(3);
    expect(api.current).toBe(3);
  });

  it('★ keeps a null `currentPlan`, which means the tenant has no plan at all', async () => {
    /*
     * `.nullable()` and not just `.optional()`: the resolver sends an explicit
     * `null` for a tenant with no subscription, and that is a different fact from
     * the field being absent.
     */
    respond(402, { code: 'PLAN_FEATURE_REQUIRED', feature: 'ai.copilot', currentPlan: null });
    const api = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(api.currentPlan).toBeNull();
  });
});

describe('★★ 1aaaefe4 — a 422 key-form refusal keeps its merchant sentence', () => {
  it('`{ error, message }` → developerMessage and userMessage, through the real client', async () => {
    respond(422, { error: 'validation_failed', message: 'WooCommerce rejected those keys.' });
    const caught = await buy().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(422);
    expect((caught as ApiError).developerMessage).toBe('validation_failed');
    expect((caught as ApiError).userMessage).toBe('WooCommerce rejected those keys.');
  });
});

describe('★★ a sentence in `detail` no longer costs the whole refusal', () => {
  it('Shopify’s claim 409: `error` and `data` survive a string `detail`', async () => {
    respond(409, {
      error: 'another_store_connected',
      detail: 'This workspace is connected to old.myshopify.com.',
      data: { currentShopDomain: 'old.myshopify.com', incomingShopDomain: 'new.myshopify.com' },
    });
    const caught = (await buy().catch((e: unknown) => e)) as ApiError;
    expect(caught.developerMessage).toBe('another_store_connected');
    expect(caught.errorData).toEqual({
      currentShopDomain: 'old.myshopify.com',
      incomingShopDomain: 'new.myshopify.com',
    });
    expect(caught.failureDetail).toBeUndefined();
  });
});

describe('★ a success hands its headers to who asked (Shopify’s intent cookie)', () => {
  it('Set-Cookie reaches onResponseHeaders, before the body is parsed', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ url: 'https://apps.shopify.com/x' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'gotcha_shopify_intent=h; Path=/',
          },
        }),
    );
    let seen: string[] = [];
    await client.get({
      endpoint: billingEndpoints.creditsBuy(),
      payload: z.unknown(),
      onResponseHeaders: (h) => {
        seen = h.getSetCookie();
      },
    });
    expect(seen).toEqual(['gotcha_shopify_intent=h; Path=/']);
  });
});
