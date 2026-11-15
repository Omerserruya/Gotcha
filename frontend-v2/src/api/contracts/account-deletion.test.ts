import { describe, expect, it } from 'vitest';

import { deletionConfirmedSchema, deletionRequestedSchema, isEmailLike } from './account-deletion';

/** The public deletion contract (Backend-Team, CONTRACT.md 2026-11-14). */
describe('★★ account deletion, read', () => {
  it('★ request: only `accepted: true` is a request taken; anything else is not', () => {
    expect(deletionRequestedSchema.safeParse({ data: { accepted: true } }).success).toBe(true);
    expect(deletionRequestedSchema.safeParse({ data: { accepted: false } }).success).toBe(false);
    expect(deletionRequestedSchema.safeParse({ data: {} }).success).toBe(false);
  });

  it('★★ confirm: deleteBy as sent; a missing or unreadable date is null, never invented', () => {
    const read = (data: object) => deletionConfirmedSchema.parse({ data }).data;
    expect(
      read({ status: 'scheduled', deleteBy: '2026-12-14T10:00:00Z', email: 'd***@a.co.il' }),
    ).toEqual({
      status: 'scheduled',
      deleteBy: '2026-12-14T10:00:00Z',
      email: 'd***@a.co.il',
    });
    expect(read({ status: 'scheduled' })).toMatchObject({ deleteBy: null, email: null });
    expect(read({ status: 'scheduled', deleteBy: 'soon' }).deleteBy).toBeNull();
  });

  it('★ confirm: a status that is not "scheduled" is not a confirmation', () => {
    expect(deletionConfirmedSchema.safeParse({ data: { status: 'pending' } }).success).toBe(false);
  });

  it.each([
    ['dana@aviv.co.il', true],
    ['  dana@aviv.co.il ', true],
    ['dana@aviv', false],
    ['dana aviv@x.co', false],
    ['@aviv.co.il', false],
    ['', false],
  ])('isEmailLike(%j) is %s', (value, ok) => {
    expect(isEmailLike(value)).toBe(ok);
  });
});
