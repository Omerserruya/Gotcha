import { describe, expect, it } from 'vitest';

import {
  catalogSchema,
  groupByDomain,
  permissionDefSchema,
  roundTrips,
  selectionToFeatures,
  SCOPES,
  takesScope,
} from './permission-catalog';

/**
 * The property that made this screen a catalogue instead of the design's grid.
 */

const perm = (over: Partial<ReturnType<typeof permissionDefSchema.parse>> = {}) =>
  permissionDefSchema.parse({
    key: 'conversation:messages:read',
    domain: 'conversation',
    feature: 'messages',
    subFeature: 'messages',
    action: 'read',
    scoped: true,
    displayName: 'Read conversations',
    description: 'See the messages in a conversation',
    ...over,
  });

describe('the round trip — the reason this is not a grid', () => {
  it('returns exactly what it was given when nothing changed', () => {
    /*
     * The design's four-level radio over five independent keys cannot do
     * this. It must pick one of four levels to represent five booleans, so
     * saving an untouched role drops whatever the levels cannot express —
     * silently, with no error and no warning.
     *
     * A control that cannot represent a state the system can be in will
     * eventually be used to destroy that state.
     */
    const original = [
      'conversation:messages:read',
      'conversation:messages:close',
      'customer:profile:export',
    ];
    expect(roundTrips(original, selectionToFeatures(original))).toBe(true);
  });

  it('notices when a key is dropped', () => {
    const original = ['a:b:read', 'a:b:reply', 'a:b:close'];
    expect(roundTrips(original, ['a:b:read', 'a:b:close'])).toBe(false);
  });

  it('notices when a key appears that was not selected', () => {
    expect(roundTrips(['a:b:read'], ['a:b:read', 'a:b:reply'])).toBe(false);
  });

  it('does not care about order, because a set is not a list', () => {
    expect(roundTrips(['b', 'a'], ['a', 'b'])).toBe(true);
  });

  it('preserves the exact combination the grid could not express', () => {
    // "Can read and close but not reply" — five independent actions, and the
    // one a shift lead plausibly needs. A four-way level has no value for it.
    const awkward = ['conversation:messages:read', 'conversation:messages:close'];
    expect(selectionToFeatures(awkward)).toEqual(awkward);
    expect(roundTrips(awkward, selectionToFeatures(awkward))).toBe(true);
  });
});

describe('scope is per role, and only where it applies', () => {
  it('offers the four the platform defines', () => {
    expect([...SCOPES]).toEqual(['own', 'team', 'department', 'workspace']);
  });

  it('refuses a scope on a permission that declares none', () => {
    // `PermissionDef.scoped` is a boolean — whether the dimension APPLIES,
    // not what it is set to. A greyed scope control on a row that has none
    // is the same lie in miniature.
    expect(takesScope(perm({ scoped: false }))).toBe(false);
    expect(takesScope(perm({ scoped: true }))).toBe(true);
  });

  it('keeps no scope field on a permission at all', () => {
    const surface = Object.keys(perm());
    expect(surface).toContain('scoped');
    expect(surface.filter((k) => /^scope$|scopeValue|limit|amount/i.test(k))).toEqual([]);
  });
});

describe('grouping', () => {
  it('groups by domain in catalogue order', () => {
    const groups = groupByDomain([
      perm({ key: 'a:x:read', domain: 'conversation' }),
      perm({ key: 'b:y:read', domain: 'customer' }),
      perm({ key: 'a:z:read', domain: 'conversation' }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(['conversation', 'customer']);
    expect(groups[0]!.permissions).toHaveLength(2);
  });

  it('parses the route envelope and drops scopes it does not know', () => {
    const parsed = catalogSchema.parse({
      data: {
        permissions: [{ key: 'a:b:read' }],
        scopes: ['own', 'team', 'galaxy'],
      },
    });
    expect(parsed.scopes).toEqual(['own', 'team']);
  });
});
