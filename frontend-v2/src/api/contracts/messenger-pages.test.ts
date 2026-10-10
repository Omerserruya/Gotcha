import { describe, expect, it } from 'vitest';

import { messengerCandidatesSchema, messengerSelectSchema } from './channels';

/*
 * Backend 0ce84f21, `services/auth/src/routes/channels.ts`: the shapes the
 * route writes, and what this build does with a field it does not know.
 */
describe('★★ GET /messenger/candidates', () => {
  it('reads what the route writes - the client has already unwrapped `data`', () => {
    expect(
      messengerCandidatesSchema.parse({
        pages: [
          {
            id: 'p1',
            name: 'Shop',
            category: 'Retail',
            connectedHere: true,
            takenElsewhere: false,
          },
          { id: 'p2', name: 'Cafe', category: null, connectedHere: false, takenElsewhere: true },
        ],
        expiresAt: '2026-10-10T10:15:00.000Z',
      }),
    ).toEqual({
      pages: [
        { id: 'p1', name: 'Shop', category: 'Retail', connectedHere: true, takenElsewhere: false },
        { id: 'p2', name: 'Cafe', category: null, connectedHere: false, takenElsewhere: true },
      ],
    });
  });

  it('★ one Page described in a way this build does not know costs that field, not the list', () => {
    const read = messengerCandidatesSchema.parse({
      pages: [
        { id: 'p1', name: 7, connectedHere: 'yes', takenElsewhere: null, tokens: 'x' },
        { name: 'no id' },
        null,
        { id: 'p3', name: 'Kept' },
      ],
    });
    expect(read.pages).toEqual([
      { id: 'p1', name: '', category: null, connectedHere: false, takenElsewhere: false },
      { id: 'p3', name: 'Kept', category: null, connectedHere: false, takenElsewhere: false },
    ]);
    // A token, were one ever sent, is not carried onward.
    expect(JSON.stringify(read)).not.toContain('tokens');
  });

  it('no `pages` at all reads as none, not a contract failure', () => {
    expect(messengerCandidatesSchema.parse({ expiresAt: 'x' })).toEqual({ pages: [] });
  });
});

describe('★★ POST /messenger/select', () => {
  it('connected / reconnected / taken, each with its subscription', () => {
    expect(
      messengerSelectSchema.parse({
        results: [
          { id: 'p1', name: 'Shop', status: 'connected', subscribed: true },
          { id: 'p2', name: 'Cafe', status: 'reconnected', subscribed: false },
          { id: 'p3', name: 'Other', status: 'taken', subscribed: false },
        ],
        connected: 2,
      }).results,
    ).toEqual([
      { id: 'p1', name: 'Shop', status: 'connected', subscribed: true },
      { id: 'p2', name: 'Cafe', status: 'reconnected', subscribed: false },
      { id: 'p3', name: 'Other', status: 'taken', subscribed: false },
    ]);
  });

  it('★ an unknown status reads as `unknown` - the other Pages’ answers survive it', () => {
    const { results } = messengerSelectSchema.parse({
      results: [
        { id: 'p1', name: 'Shop', status: 'queued', subscribed: true },
        { id: 'p2', name: 'Cafe', status: 'connected' },
        'garbage',
      ],
    });
    expect(results).toEqual([
      { id: 'p1', name: 'Shop', status: 'unknown', subscribed: true },
      // No `subscribed`: no claim either way.
      { id: 'p2', name: 'Cafe', status: 'connected', subscribed: null },
    ]);
  });

  it('`status: "toString"` is not a status', () => {
    expect(
      messengerSelectSchema.parse({ results: [{ id: 'p', status: 'toString' }] }).results[0]
        ?.status,
    ).toBe('unknown');
  });
});
