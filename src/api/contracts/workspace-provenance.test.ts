import { describe, expect, it } from 'vitest';

import { anyFieldAttributed, fieldOrigin, isUnusableValue, workspaceSchema } from './workspace';

const workspace = (fieldSources: Record<string, string | null> = {}) =>
  workspaceSchema.parse({ fieldSources });

describe('null provenance means unknown, never “from the website”', () => {
  it('★ reads an unmarked field as unknown rather than scan-owned', () => {
    /*
     * The single mistake the whole feature exists to prevent. The profile is
     * seeded by an onboarding confirm step that "means two different things:
     * 'the scan proposed this' and 'the human accepted or corrected it'", so
     * assuming the scan wrote it is what would overwrite a correction.
     */
    expect(fieldOrigin(workspace({ industry: null }), 'industry')).toBe('unknown');
    expect(fieldOrigin(workspace({ industry: null }), 'industry')).not.toBe('scan');
  });

  it('reads a field absent from the map as unknown too', () => {
    expect(fieldOrigin(workspace({}), 'country')).toBe('unknown');
  });

  it('reads the two marked states as themselves', () => {
    const w = workspace({ industry: 'scan', businessDescription: 'human' });
    expect(fieldOrigin(w, 'industry')).toBe('scan');
    expect(fieldOrigin(w, 'businessDescription')).toBe('human');
  });
});

describe('nothing is attributed anywhere yet', () => {
  it('★ reports the estate’s actual state: no field is marked', () => {
    // `tenant_settings WHERE key='profileFieldProvenance'` — zero rows, whole
    // database. So a rescan applies nothing and offers everything, today.
    const measured = workspace({
      organizationName: null,
      businessDescription: null,
      industry: null,
      country: null,
    });
    expect(anyFieldAttributed(measured)).toBe(false);
  });

  it('reports true as soon as one field is marked', () => {
    // Self-healing: once a scan writes through the service the field is
    // marked and refreshes silently forever after.
    expect(anyFieldAttributed(workspace({ industry: 'scan' }))).toBe(true);
  });

  it('counts a human mark as attribution too', () => {
    // "We know a person wrote this" is knowledge, not an absence of it.
    expect(anyFieldAttributed(workspace({ businessDescription: 'human' }))).toBe(true);
  });
});

describe('a value of “unknown” is not a value', () => {
  it('★ refuses to render the literal string this tenant stores', () => {
    // `country` is the string "unknown" on this tenant. Printed as-is it
    // reads as a country called "unknown".
    expect(isUnusableValue('unknown')).toBe(true);
    expect(isUnusableValue('Unknown')).toBe(true);
    expect(isUnusableValue('  unknown  ')).toBe(true);
  });

  it('treats blank and missing the same way', () => {
    expect(isUnusableValue(null)).toBe(true);
    expect(isUnusableValue(undefined)).toBe(true);
    expect(isUnusableValue('   ')).toBe(true);
  });

  it('leaves a real value alone', () => {
    expect(isUnusableValue('IL')).toBe(false);
    // And does not over-reach: a country whose name contains the word.
    expect(isUnusableValue('Unknown Island')).toBe(false);
  });
});
