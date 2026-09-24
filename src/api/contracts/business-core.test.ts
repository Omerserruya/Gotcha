import { describe, expect, it } from 'vitest';

import {
  businessCoreSchema,
  connectedButFailing,
  electable,
  electedElsewhere,
  isInferred,
  needsMarketplace,
  partState,
  rolePartSchema,
} from './business-core';

const part = (over: Record<string, unknown> = {}) =>
  rolePartSchema.parse({ role: 'ecommerce', ...over });

/** The estate as measured: one errored Shopify, nothing else connected. */
const MEASURED = businessCoreSchema.parse({
  useCase: null,
  roles: [
    {
      role: 'ecommerce',
      // A row exists and its status is ERROR, so `connected` is false and the
      // raw status travels. Backend found this live: reporting the row's mere
      // existence as connected offered a system the write then refused.
      candidates: [{ slug: 'shopify', name: 'Shopify', connected: false, status: 'ERROR' }],
    },
    { role: 'payments', candidates: [{ slug: 'stripe', name: 'Stripe', connected: false }] },
    { role: 'shipping', available: false, reason: 'no_integrations_exist', candidates: [] },
    { role: 'returns', candidates: [{ slug: 'returngo', name: 'ReturnGO', connected: false }] },
    { role: 'crm', candidates: [{ slug: 'hubspot', name: 'HubSpot', connected: false }] },
  ],
  catalogueNotes: ['The shipping category exists and contains no integrations.'],
});

describe('★ impossible is not the same as nothing connected', () => {
  it('separates a part nothing could ever serve from one nobody has connected', () => {
    /*
     * "'Nothing exists to choose' and 'nothing connected yet' need different
     * sentences and an empty list reads as the second." Shipping has a
     * category and zero integrations — empty for every tenant, forever.
     */
    expect(partState(part({ available: false, reason: 'no_integrations_exist' }))).toBe(
      'impossible',
    );
    expect(partState(part({ candidates: [] }))).toBe('nothing_connected');
  });

  it('distinguishes connected-but-unchosen from chosen', () => {
    const connected = part({
      candidates: [{ slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' }],
    });
    expect(partState(connected)).toBe('connected_none_chosen');

    const chosen = part({
      elected: { slug: 'shopify', name: 'Shopify' },
      candidates: [{ slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' }],
    });
    expect(partState(chosen)).toBe('chosen');
  });

  it('★ never calls an impossible part merely unconnected', () => {
    // The distinction the whole screen turns on: one is the tenant's to fix
    // and the other is not.
    const shipping = MEASURED.roles.find((r) => r.role === 'shipping')!;
    expect(partState(shipping)).toBe('impossible');
    expect(needsMarketplace(MEASURED).some((p) => p.role === 'shipping')).toBe(false);
  });
});

describe('★ the CRM is the one part this endpoint refuses', () => {
  const connectedCandidate = [{ slug: 'x', name: 'X', connected: true, status: 'CONNECTED' }];

  it('★ elects the two parts that have no elector of their own', () => {
    /*
     * I had this exactly inverted before reading Backend's commit: I assumed
     * the CRM was the only electable part because it was the only one with a
     * writer. It is one of the two `PUT /business-core/role` REFUSES.
     *
     * And RETURNS joined it at 2d1abf88. `config.returnProvider` is an
     * explicit switch the AI already reads, whose own header says "explicit
     * selection wins over inference" — so `config.roles` carries only the
     * parts that had no elector at all.
     *
     * ★ The two refusals point at DIFFERENT screens, so they are different
     * answers rather than one "not here". Asserted as the DESTINATION, not
     * as a boolean: a predicate returning true for both would let one
     * sentence serve both, and send somebody to the CRM screen to change
     * returns.
     */
    for (const role of ['ecommerce', 'payments'] as const) {
      expect(electable(part({ role, candidates: connectedCandidate }))).toBe(true);
    }
    for (const role of ['crm', 'returns'] as const) {
      expect(electable(part({ role, candidates: connectedCandidate }))).toBe(false);
    }
    expect(electedElsewhere(part({ role: 'crm' }))).toBe('crm');
    expect(electedElsewhere(part({ role: 'returns' }))).toBe('returns');
    expect(electedElsewhere(part({ role: 'ecommerce' }))).toBeNull();
  });

  it('★ tells an inferred system from a chosen one', () => {
    /*
     * `returns` resolves to Shopify because a capability resolver found it
     * could serve returns. No merchant said so, and the prompt the model
     * receives spells it out: "shopify (inferred, not chosen by the
     * business)".
     *
     * `elected` alone cannot tell these apart, which is why the route serves
     * `source` — and why our schema, being `object` rather than
     * `looseObject`, was stripping it at the boundary until now. The UI
     * could not have drawn the distinction even in principle.
     */
    const inferred = part({
      role: 'returns',
      elected: { slug: 'shopify', name: 'Shopify' },
      source: 'inferred',
    });
    const chosen = part({
      role: 'ecommerce',
      elected: { slug: 'shopify', name: 'Shopify' },
      source: 'elected',
    });
    expect(isInferred(inferred)).toBe(true);
    expect(isInferred(chosen)).toBe(false);
    // An inferred NOTHING is not an inference worth showing.
    expect(isInferred(part({ role: 'returns', elected: null, source: 'inferred' }))).toBe(false);
  });

  it('refuses a part with nothing CONNECTED behind it', () => {
    // The write refuses an election for a system that is not connected, so
    // offering the control would be offering one the server rejects.
    expect(electable(part({ role: 'payments', candidates: [] }))).toBe(false);
    expect(
      electable(
        part({
          role: 'ecommerce',
          candidates: [{ slug: 'shopify', name: 'Shopify', connected: false, status: 'ERROR' }],
        }),
      ),
    ).toBe(false);
  });

  it('refuses a part nothing could ever serve', () => {
    expect(
      electable(part({ role: 'returns', available: false, candidates: connectedCandidate })),
    ).toBe(false);
  });
});

describe('★ connected, never connected, and connected-but-failing are three', () => {
  it('tells a broken connection from an absent one', () => {
    /*
     * The merchant has already done the work on a failing one, so "connect
     * it" is the wrong instruction — "fix it" is. `status: null` means they
     * never started.
     */
    expect(connectedButFailing({ connected: false, status: 'ERROR' })).toBe(true);
    expect(connectedButFailing({ connected: false, status: null })).toBe(false);
    expect(connectedButFailing({ connected: true, status: 'CONNECTED' })).toBe(false);
  });

  it('★ reports our own ecommerce part as failing, not as unconnected', () => {
    const ecommerce = MEASURED.roles.find((r) => r.role === 'ecommerce')!;
    expect(partState(ecommerce)).toBe('connected_but_failing');
  });

  it('does not let one broken system hide a working one', () => {
    // Checked AFTER connected, so a healthy candidate wins.
    const mixed = part({
      candidates: [
        { slug: 'a', name: 'A', connected: false, status: 'ERROR' },
        { slug: 'b', name: 'B', connected: true, status: 'CONNECTED' },
      ],
    });
    expect(partState(mixed)).toBe('connected_none_chosen');
  });
});

describe('the marketplace is where connecting happens', () => {
  it('★ names exactly the parts worth going there for', () => {
    /*
     * Not shipping — nothing exists to connect. Not ecommerce — its Shopify
     * has been connected and is failing, so the marketplace is where it gets
     * FIXED, not where it gets added.
     *
     * Payments, returns and CRM have candidates and nothing started, which is
     * the only state a trip to the marketplace to CONNECT fixes.
     */
    expect(needsMarketplace(MEASURED).map((p) => p.role)).toEqual(['payments', 'returns', 'crm']);
  });
});

describe('the use case decides which parts are asked about', () => {
  it('is null until somebody chooses', () => {
    expect(businessCoreSchema.parse({}).useCase).toBeNull();
  });

  it('keeps the platform’s catalogue notes rather than re-deriving them', () => {
    // Two facts the catalogue cannot express, written once server-side so
    // each client does not rediscover them.
    expect(MEASURED.catalogueNotes[0]).toMatch(/shipping category/i);
  });
});
