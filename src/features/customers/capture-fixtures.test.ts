import { describe, expect, it, vi } from 'vitest';

import type { CustomerRow } from '@/api/contracts/customers';

import { FIXTURE_MARKER, withCaptureFixtures } from './capture-fixtures';

const { enabled } = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock('@/features/security/capture-fixtures', () => ({ captureFixturesEnabled: enabled }));

/**
 * The substitution, in both directions.
 *
 * The gate itself (`captureFixturesEnabled`) has its own test in the security
 * feature and is not re-tested here — it is imported unchanged precisely so
 * there is one mechanism rather than two that can drift. What is tested here
 * is that this screen uses it correctly, and that a broken read stays broken.
 */

const real: CustomerRow[] = [
  {
    id: 'real-1',
    externalId: '+972500000000',
    displayName: 'A Real Person',
    channel: 'WHATSAPP',
    phone: '+972500000000',
    email: 'real@a-real-domain.example',
    tags: [],
    lastInteractionAt: null,
    source: null,
    personId: null,
    mergedIntoId: null,
  },
];

describe('withCaptureFixtures', () => {
  it('leaves the real list alone when the gate is shut', () => {
    enabled.mockReturnValue(false);
    expect(withCaptureFixtures(real, '')).toBe(real);
  });

  it('substitutes when the gate is open', () => {
    enabled.mockReturnValue(true);
    const rows = withCaptureFixtures(real, '');
    expect(rows).not.toBe(real);
    expect(rows!.some((r) => r.email?.includes(FIXTURE_MARKER))).toBe(true);
    expect(rows!.some((r) => r.displayName === 'A Real Person')).toBe(false);
  });

  it('keeps a failed read a failed read', () => {
    // Fixtures make evidence safe. They must never make a broken screen look
    // like a working one — a capture of a substituted list on top of a failed
    // load would be evidence of nothing.
    enabled.mockReturnValue(true);
    expect(withCaptureFixtures(null, '')).toBeNull();
  });

  it('applies the query to the fixtures too', () => {
    enabled.mockReturnValue(true);
    expect(withCaptureFixtures(real, 'Avery')).toHaveLength(2);
    expect(withCaptureFixtures(real, 'Zzyzx')).toHaveLength(0);
  });

  it('carries two rows that share a personId, so the collapse is in evidence', () => {
    enabled.mockReturnValue(true);
    const rows = withCaptureFixtures(real, '')!;
    const shared = rows.filter((r) => r.personId === 'fixture-person-1');
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((r) => r.channel)).size).toBe(2);
  });

  it('uses only reserved identifiers that can never belong to anyone', () => {
    enabled.mockReturnValue(true);
    for (const row of withCaptureFixtures(real, '')!) {
      if (row.email) expect(row.email).toMatch(/@example\.(com|org|net)$/);
      // Ofcom drama range, reserved for exactly this.
      if (row.phone) expect(row.phone).toMatch(/^\+447700900\d{3}$/);
    }
  });
});
