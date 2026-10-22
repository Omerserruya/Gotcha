import { describe, expect, it } from 'vitest';

import {
  currentUserSchema,
  identitySuggestionsSchema,
  membershipSchema,
  suggestionMatch,
} from './identity';

/**
 * `GET /api/auth/me`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE BODY BELOW IS THE ROUTE'S, NOT A SHAPE WE FOUND CONVENIENT
 * ════════════════════════════════════════════════════════════════════════════
 * Copied from `listMemberships` in `services/auth/src/routes/auth.ts:24` and
 * from the `res.json` beneath it. The contract this replaces required
 * `tenantId` at the top of a membership, which that route has never sent -
 * the tenant is nested - so it rejected every response the endpoint has ever
 * produced, and took two screens with it.
 */

/** Exactly what the route returns, field for field. */
const ME = {
  user: {
    id: 'cms4ug98s0006chmrtrbt3haa',
    email: 'someone@example.com',
    name: 'Dana Levi',
    role: 'ADMIN',
    tenantId: 'cms4ug98n0004chmrp4lv6ujl',
    identityId: 'idn_1',
    isActive: true,
    createdAt: '2026-01-04T08:00:00.000Z',
  },
  tenantStatus: 'ACTIVE',
  tenantName: 'Gotcha',
  memberships: [
    {
      userId: 'cms4ug98s0006chmrtrbt3haa',
      role: 'ADMIN',
      lastActiveAt: '2026-09-25T07:00:00.000Z',
      memberSince: '2026-01-04T08:00:00.000Z',
      tenant: {
        id: 'cms4ug98n0004chmrp4lv6ujl',
        name: 'Gotcha',
        slug: 'gotcha',
        status: 'ACTIVE',
        isActive: true,
      },
    },
  ],
};

describe('★★ the shape the route actually sends', () => {
  it('★★ parses a real body, which the previous contract could not', async () => {
    /*
     * THE DEFECT. `tenantId` was required at the top of a membership and is
     * nested at `tenant.id`. One required key that does not exist fails the
     * element, the array, and the whole response - `looseObject` and the
     * optional siblings cannot rescue it.
     */
    const parsed = currentUserSchema.parse(ME);
    expect(parsed.user.id).toBe('cms4ug98s0006chmrtrbt3haa');
    expect(parsed.memberships[0]?.tenantId).toBe('cms4ug98n0004chmrp4lv6ujl');
    expect(parsed.memberships[0]?.name).toBe('Gotcha');
  });

  it('★★ a contract can fail on a field nobody uses and take the screen with it', () => {
    /*
     * Neither caller reads `memberships`. 04f wants `user.id` and screen 18
     * wants `user.phoneNumber`, and both got nothing for as long as this was
     * wrong - the edit control hidden from every author, and the WhatsApp
     * destination reading as absent for everybody.
     *
     * Asserted as the property that matters: the field the callers DO use
     * must survive a membership list we have no interest in.
     */
    const parsed = currentUserSchema.parse({ ...ME, memberships: ME.memberships });
    expect(parsed.user.id).toBeTruthy();
  });

  it('★ tolerates a null tenant name, which the route can send', () => {
    // `tenantName: tenant?.name ?? null`. `z.string().optional()` rejects
    // null - a second route into the same blank screen, from a tenant row
    // that could not be read.
    expect(currentUserSchema.parse({ ...ME, tenantName: null }).tenantName).toBeNull();
    expect(
      currentUserSchema.parse({
        ...ME,
        memberships: [{ ...ME.memberships[0], tenant: { id: 't1', name: null } }],
      }).memberships[0]?.tenantId,
    ).toBe('t1');
  });

  it('★ keeps `userId`, which is the User.id an author is compared against', () => {
    /*
     * `listMemberships` maps `userId: m.id` over `prisma.user`, so this is
     * `User.id` - the same id `CustomerNote.authorUserId` holds, and NOT the
     * session's Authentik `sub`. Verified at the mapping rather than
     * inferred from the shape of the string, because the whole point of this
     * read is that two identifiers for one person were being confused.
     */
    expect(membershipSchema.parse(ME.memberships[0]).userId).toBe(ME.user.id);
  });

  it('★★ still refuses a body with no user id at all', () => {
    // The fix must not become "accept anything". `user.id` is what both
    // callers came for, and a response without it is not usable.
    expect(() => currentUserSchema.parse({ ...ME, user: { email: 'x@example.com' } })).toThrow();
  });
});

/*
 * ★★ `GET /api/identity/suggestions` (Backend 83579ac8), the `data` array as
 * the route builds it (services/conversation/src/routes/identity.ts): a new
 * link record and an older AI-written row, each with both customers' labels.
 * The transport unwraps `data`, so the schema reads the array.
 */
const LINK_ITEM = {
  id: 'identity:link:ig1:wa1',
  source: 'link',
  contactIds: ['ig1', 'wa1'],
  signal: 'same_name',
  identifier: null,
  status: 'PENDING',
  at: '2026-10-11T10:00:00Z',
  contacts: [
    { id: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
    { id: 'wa1', label: 'Omer Tsruya', channel: 'WHATSAPP' },
  ],
};
const LEGACY_ITEM = {
  id: 's1',
  source: 'legacy',
  contactIds: ['wa2', 'ig1'],
  signal: 'ai_extracted_identifier',
  identifier: { type: 'EMAIL', value: 'd@x.com' },
  status: 'PENDING',
  at: '2026-08-02T08:46:53.000Z',
  contacts: [
    { id: 'wa2', label: 'Dana', channel: 'WHATSAPP' },
    { id: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
  ],
};

describe('★★ 04’s suggested pairs - the server’s shape, a bad item left out', () => {
  it('reads both kinds of item as sent', () => {
    const [link, legacy] = identitySuggestionsSchema.parse([LINK_ITEM, LEGACY_ITEM]);
    expect(link).toEqual({
      id: 'identity:link:ig1:wa1',
      source: 'link',
      contactIds: ['ig1', 'wa1'],
      signal: 'same_name',
      identifier: null,
      contacts: LINK_ITEM.contacts,
    });
    expect(legacy?.contactIds).toEqual(['wa2', 'ig1']);
    expect(legacy?.identifier).toEqual({ type: 'EMAIL', value: 'd@x.com' });
    expect(legacy?.contacts.map((c) => c.label)).toEqual(['Dana', 'Instagram customer']);
  });

  it('a malformed item is dropped, not the read', () => {
    expect(
      identitySuggestionsSchema
        .parse([
          LINK_ITEM,
          { ...LINK_ITEM, contacts: [LINK_ITEM.contacts[0]] },
          { ...LINK_ITEM, contactIds: ['ig1', 'ig1'] },
          { ...LINK_ITEM, contactIds: ['ig1', 'zz'] },
          { ...LINK_ITEM, contacts: [{ id: 'ig1', label: '' }, LINK_ITEM.contacts[1]] },
          'nonsense',
        ])
        .map((s) => s.id),
    ).toEqual(['identity:link:ig1:wa1']);
  });

  it('a signal or source this app has no words for keeps the pair', () => {
    const [item] = identitySuggestionsSchema.parse([
      { ...LINK_ITEM, signal: 'brand_new_signal', source: 'elsewhere', identifier: 7 },
    ]);
    expect(item?.signal).toBe('brand_new_signal');
    expect(item?.identifier).toBeNull();
    expect(item && suggestionMatch(item)).toBe('other');
  });

  it('what they share: the name, a phone or an email, in either case', () => {
    const [link, legacy] = identitySuggestionsSchema.parse([LINK_ITEM, LEGACY_ITEM]);
    expect(link && suggestionMatch(link)).toBe('sameName');
    expect(legacy && suggestionMatch(legacy)).toBe('email');
    const [typed] = identitySuggestionsSchema.parse([
      {
        ...LINK_ITEM,
        signal: 'unproven_identifier',
        identifier: { type: 'phone', value: '+9725' },
      },
    ]);
    expect(typed && suggestionMatch(typed)).toBe('phone');
  });
});

/*
 * ★★ Backend 3ac2a71e: each side's `contactId` and `channel`, and the pair's
 * `evidence` - copied from services/conversation/src/lib/link-evidence.ts and
 * its route test. Every new field is optional: an older server still parses.
 */
describe('★★ the proof for a pair (Backend 3ac2a71e)', () => {
  const withEvidence = (evidence: unknown) =>
    identitySuggestionsSchema.parse([{ ...LINK_ITEM, evidence }])[0]?.evidence;

  it('keeps each contact’s contactId', () => {
    const [item] = identitySuggestionsSchema.parse([
      {
        ...LINK_ITEM,
        contacts: LINK_ITEM.contacts.map((c) => ({ ...c, contactId: c.id })),
      },
    ]);
    expect(item?.contacts.map((c) => c.contactId)).toEqual(['ig1', 'wa1']);
  });

  it.each([
    ['name', { type: 'name', names: [null, 'Omer Tsruya'] }],
    ['phone', { type: 'phone', value: '+972 5X-XXX-3421' }],
    ['email', { type: 'email', value: 'd***@x.com' }],
    [
      'shopify_customer',
      { type: 'shopify_customer', shopifyCustomerId: '7012', provenBy: 'verified_profile_update' },
    ],
  ])('reads %s evidence as sent', (_, evidence) => {
    expect(withEvidence(evidence)).toEqual(evidence);
  });

  it('null evidence is null', () => {
    expect(withEvidence(null)).toBeNull();
  });

  it.each([
    ['an unknown type', { type: 'fingerprint', value: 'abc' }],
    ['a phone with no value', { type: 'phone' }],
    ['one name', { type: 'name', names: ['Omer'] }],
    ['not an object', 'phone'],
  ])('%s is no evidence, and the pair is kept', (_, evidence) => {
    const rows = identitySuggestionsSchema.parse([{ ...LINK_ITEM, evidence }]);
    expect(rows.map((r) => r.id)).toEqual(['identity:link:ig1:wa1']);
    expect(rows[0]?.evidence).toBeNull();
  });

  it('an item from before 3ac2a71e (no contactId, no evidence) still parses', () => {
    const [item] = identitySuggestionsSchema.parse([LINK_ITEM]);
    expect(item?.contactIds).toEqual(['ig1', 'wa1']);
    expect(item?.evidence ?? null).toBeNull();
    expect(item?.contacts.map((c) => c.contactId ?? null)).toEqual([null, null]);
  });
});

describe('★★ F1 - the links read, per row', () => {
  it('a row that does not parse is left out - never the whole list', async () => {
    const { identityLinksSchema } = await import('./identity');
    const read = identityLinksSchema.parse({
      personId: 'p1',
      linked: [{ contactId: 'a', label: 'A', channel: 'WHATSAPP' }, { contactId: 42 }],
    });
    expect(read.linked.map((row) => row.contactId)).toEqual(['a']);
  });

  it('a link or an unlink it cannot read is null - no button', async () => {
    const { identityLinksSchema } = await import('./identity');
    const [row] = identityLinksSchema.parse({
      personId: 'p1',
      linked: [{ contactId: 'a', link: { contactIds: ['x'] }, unlink: { contactIds: 'x' } }],
    }).linked;
    expect(row!.link).toBeNull();
    expect(row!.unlink).toBeNull();
  });
});

describe('★ F1 - an accepted suggestion says what it had in common', () => {
  it('fromSignal over signal: "accepted_suggestion" from similar names reads as similar names', async () => {
    const { identityLinksSchema, linkMatch } = await import('./identity');
    const [row] = identityLinksSchema.parse({
      personId: 'p1',
      linked: [
        {
          contactId: 'a',
          link: {
            contactIds: ['me', 'a'],
            signal: 'accepted_suggestion',
            fromSignal: 'similar_name',
          },
        },
      ],
    }).linked;
    expect(linkMatch(row!.link!)).toBe('similarName');
  });

  it('no fromSignal: the signal itself', async () => {
    const { identityLinksSchema, linkMatch } = await import('./identity');
    const [row] = identityLinksSchema.parse({
      personId: 'p1',
      linked: [{ contactId: 'a', link: { contactIds: ['me', 'a'], signal: 'same_name' } }],
    }).linked;
    expect(linkMatch(row!.link!)).toBe('sameName');
  });
});
