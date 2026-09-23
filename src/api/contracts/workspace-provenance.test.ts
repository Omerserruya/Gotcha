import { describe, expect, it } from 'vitest';

import {
  anyFieldAttributed,
  fieldOrigin,
  isUnusableValue,
  workspaceSchema,
  workspaceVoiceSchema,
} from './workspace';

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

describe('the voice basis is a placeholder, and the contract must accept it', () => {
  it('★ accepts the null the platform actually sends', () => {
    /*
     * All three senders hardcode `{ messagesAnalysed: null, importedAt: null }`.
     * The schema previously required a number, so a live 200 was refused and
     * the whole voice editor vanished behind "could not be loaded".
     *
     * The stub used to send 0. Backend changed it to null, which is MORE
     * truthful — zero analysed is a claim, null is "we do not know" — and the
     * guard refused the improvement.
     */
    const v = workspaceVoiceSchema.parse({
      guidance: 'Warm and direct.',
      source: 'learned',
      editedAt: null,
      basis: { messagesAnalysed: null, importedAt: null },
    });
    expect(v.basis?.messagesAnalysed).toBeNull();
    expect(v.source).toBe('learned');
  });

  it('still accepts a real count, for when the stub becomes real', () => {
    const v = workspaceVoiceSchema.parse({
      source: 'learned',
      basis: { messagesAnalysed: 240, importedAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(v.basis?.messagesAnalysed).toBe(240);
  });

  it('does not invent a zero when the field is absent', () => {
    // `default(null)` rather than `default(0)`: a provenance claim built from
    // a placeholder is worse than none.
    const v = workspaceVoiceSchema.parse({ source: 'none', basis: {} });
    expect(v.basis?.messagesAnalysed).toBeNull();
  });
});
