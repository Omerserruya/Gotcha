import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { workspaceSchema } from '@/api/contracts/workspace';
import messages from '@/i18n/messages/en/workspace.json';

import { FieldProvenance } from './FieldProvenance';

/**
 * Screen 11b.
 *
 * The attributed branch is unreachable by a capture — `profileFieldProvenance`
 * has zero rows across the whole database, so every tenant renders the
 * "nothing is marked yet" branch. The marked state, and the difference between
 * a scan badge and a human one, exist only here.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'workspace.provenance') =>
    createTranslator({ locale: 'en', messages: { workspace: messages }, namespace }),
}));

const ws = (over: Record<string, unknown> = {}) =>
  workspaceSchema.parse({
    name: 'Urban Supply - GOTCHA Demo',
    description: 'A Shopify storefront',
    industry: 'ecommerce',
    country: 'unknown',
    languages: ['he'],
    ...over,
  });

const renderPanel = async (over: Record<string, unknown> = {}) =>
  render(await FieldProvenance({ workspace: ws(over) }));

describe('★ nothing is marked, and the panel says so before the badges', () => {
  it('explains why every badge is about to say the same thing', async () => {
    /*
     * Zero provenance rows across the estate. A panel of blank badges with no
     * explanation reads as a broken feature; this says the mechanic is real
     * and has nothing to work with yet.
     */
    await renderPanel();
    expect(screen.getByTestId('provenance')).toHaveAttribute('data-attributed', 'false');

    const notice = screen.getByTestId('provenance-none');
    expect(notice).toHaveTextContent(/nothing is marked yet/i);
    expect(notice).toHaveTextContent(/ask you about every change/i);
    // The self-healing half. Without it this is an apology.
    expect(notice).toHaveTextContent(/after that it refreshes what it wrote itself/i);
  });

  it('switches to the ordinary sentence once anything is marked', async () => {
    await renderPanel({ fieldSources: { industry: 'scan' } });
    expect(screen.getByTestId('provenance')).toHaveAttribute('data-attributed', 'true');
    expect(screen.queryByTestId('provenance-none')).toBeNull();
    expect(screen.getByTestId('provenance-some')).toHaveTextContent(/refreshes the fields marked/i);
  });
});

describe('★ an unmarked field is never labelled “from your website”', () => {
  it('says the source was not recorded', async () => {
    /*
     * The one mistake the feature exists to prevent. Labelling an unmarked
     * field as scan-owned is the guess that lets a rescan overwrite a
     * correction somebody made during onboarding.
     */
    await renderPanel();
    const origins = screen.getAllByTestId('provenance-origin');
    for (const o of origins) {
      expect(o).toHaveTextContent(/source not recorded/i);
      expect(o).not.toHaveTextContent(/from your website/i);
    }
  });

  it('distinguishes scan from human when both are known', async () => {
    await renderPanel({ fieldSources: { industry: 'scan', businessDescription: 'human' } });
    const rows = screen.getAllByTestId('provenance-row');
    const scanRow = rows.find((r) => r.getAttribute('data-origin') === 'scan');
    const humanRow = rows.find((r) => r.getAttribute('data-origin') === 'human');

    expect(within(scanRow!).getByTestId('provenance-origin')).toHaveTextContent(
      /from your website/i,
    );
    expect(within(humanRow!).getByTestId('provenance-origin')).toHaveTextContent(
      /you entered this/i,
    );
  });
});

describe('★ “unknown” is not a country', () => {
  it('reports that we looked and could not read it', async () => {
    // `country` is the literal string "unknown" on this tenant. Printed it
    // reads as a country; blanked it reads as a field nobody filled in.
    await renderPanel();
    const rows = screen.getAllByTestId('provenance-row');
    const countryRow = rows.find((r) => within(r).queryByText('Country'));
    expect(within(countryRow!).getByTestId('provenance-unset')).toHaveTextContent(
      /looked and could not read this/i,
    );
    expect(countryRow).not.toHaveTextContent(/^unknown$/i);
  });

  it('says “not set” when there was never a value to reject', async () => {
    // A different fact: nothing came back at all, so nothing was rejected.
    await renderPanel({ country: null });
    const rows = screen.getAllByTestId('provenance-row');
    const countryRow = rows.find((r) => within(r).queryByText('Country'));
    expect(within(countryRow!).getByTestId('provenance-unset')).toHaveTextContent(/not set/i);
  });

  it('leaves a real value alone', async () => {
    await renderPanel({ country: 'IL' });
    const rows = screen.getAllByTestId('provenance-row');
    const countryRow = rows.find((r) => within(r).queryByText('Country'));
    expect(countryRow).toHaveTextContent('IL');
    expect(within(countryRow!).queryByTestId('provenance-unset')).toBeNull();
  });
});

describe('★ one reply language, said rather than offered', () => {
  it('states what is stored instead of drawing a control that loses data', async () => {
    /*
     * `PATCH /workspace` validates up to SIX languages and then writes
     * `primaryLanguage = languages[0]`. A multi-select would be accepted,
     * answered 200, and silently drop everything after the first.
     */
    await renderPanel();
    const note = screen.getByTestId('provenance-one-language');
    expect(note).toHaveTextContent(/holds one reply language/i);
    expect(note).toHaveTextContent(/only this one is stored/i);
  });

  it('renders the stored language as the value for that field', async () => {
    await renderPanel({ languages: ['he'] });
    const rows = screen.getAllByTestId('provenance-row');
    const langRow = rows.find((r) => within(r).queryByText('Reply language'));
    expect(langRow).toHaveTextContent('he');
  });
});
