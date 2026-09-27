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
  /*
   * The panel names country, language and currency codes in the reader's
   * language, so it needs to know which language that is. `en` here: the
   * defect this covers was a code rendered on the ENGLISH screen.
   */
  getLocale: async () => 'en',
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
    /*
     * NOT "after that it refreshes what it wrote itself", which the first
     * version of this panel promised and which cannot happen: `planRescan`
     * applies only fields already owned by `scan`, the scan stamps only what
     * it applied, and accepting a suggestion goes through PATCH, which stamps
     * `human`. `scan` is unreachable from `unknown`.
     */
    expect(notice).toHaveTextContent(/it will ask again next time/i);
    expect(notice).toHaveTextContent(/none has/i);
    expect(notice).not.toHaveTextContent(/after that it refreshes/i);
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

  it('★★ names a real country instead of printing its code', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THIS ASSERTION USED TO REQUIRE `IL` ON THE SCREEN
     * ════════════════════════════════════════════════════════════════════════
     * It read `expect(countryRow).toHaveTextContent('IL')` under the heading
     * "leaves a real value alone", and it was right that a usable value must
     * not be swallowed by the unset branch — that is what the second assertion
     * checks. It was wrong about what the reader should see.
     *
     * Which made it a PIN: naming the country turns this test red, and the
     * next person to fix the panel gets a red build and backs the fix out.
     * The criterion that catches it is not "a code appeared" — `write_orders`
     * on the capabilities screen is a code a merchant must match against
     * Shopify's own consent screen, and any paraphrase there is worse. It is
     * **is there a name available that the assertion is refusing?** For a
     * country there is, in the runtime, in both our languages.
     *
     * Asserted in both directions, so it cannot pass a panel that shows the
     * name AND the code, or one that shows neither.
     */
    await renderPanel({ country: 'IL' });
    const rows = screen.getAllByTestId('provenance-row');
    const countryRow = rows.find((r) => within(r).queryByText('Country'));
    expect(countryRow).toHaveTextContent('Israel');
    expect(countryRow).not.toHaveTextContent('IL');
    // The original point of this test, and still true: a usable value is not
    // filed under "we could not use it".
    expect(within(countryRow!).queryByTestId('provenance-unset')).toBeNull();
  });
});

describe('★ one reply language, said rather than offered', () => {
  it('says the replies are already right, then what the setting does', async () => {
    /*
     * The stored value does not participate in replies at all: the live path
     * decides from the conversation on a non-negotiable prompt rule and never
     * reads this column.
     *
     * So the sentence must NOT lead with "GOTCHA holds one reply language",
     * which is true and invites a merchant to fix something that is not
     * broken. Asserted in that order, because the order is the point.
     */
    await renderPanel();
    const note = screen.getByTestId('provenance-one-language');
    expect(note).toHaveTextContent(/replies in each customer's own language/i);
    expect(note).toHaveTextContent(/this setting does not change it/i);
    // And it still says what the setting IS for, rather than only what it is not.
    expect(note).toHaveTextContent(/tag your knowledge documents/i);
  });

  it('★★ names the reply language, two rows under a sentence about Hebrew', async () => {
    /*
     * A browser walk read *"Reply language · he"* on this list while the fact
     * table above it said **"GOTCHA runs in Hebrew."** Same page, same fact,
     * one of them in the platform's vocabulary.
     *
     * The old assertion required the code, the same way the country one did.
     * Two pins in one file, and both were written by someone (me) checking
     * that the field was WIRED — which the code assertion does prove. Wiring
     * and reading are different claims and the first is cheaper to assert,
     * which is how a test ends up making the second one impossible.
     */
    await renderPanel({ languages: ['he'] });
    const rows = screen.getAllByTestId('provenance-row');
    const langRow = rows.find((r) => within(r).queryByText('Reply language'));
    expect(langRow).toHaveTextContent('Hebrew');
  });

  it('★ falls back to the code for a language nobody can name', async () => {
    /*
     * `Intl.DisplayNames.of` returns its input for a well-formed code it does
     * not know. Showing `zz` is the honest end of that road — the alternative
     * is a blank row on a panel whose entire subject is where values came from.
     */
    await renderPanel({ languages: ['zz'] });
    const rows = screen.getAllByTestId('provenance-row');
    const langRow = rows.find((r) => within(r).queryByText('Reply language'));
    expect(langRow).toHaveTextContent('zz');
  });

  it('★ isolates the value, because this list renders the same strings as the facts table', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * ONE SCREENSHOT HELD THE SAME STRING FIXED AND BROKEN, 500 PIXELS APART
     * ════════════════════════════════════════════════════════════════════════
     * Wave 1 put `UserText` on `FactRows` and four other surfaces. This list
     * shows the SAME workspace strings and was not touched, because the walk
     * that found the defect photographed the table. So Settings · Workspace
     * rendered "What you sell" correctly at the top and scrambled below.
     *
     * ⚠ This asserts the isolate is PRESENT. It cannot see visual order — no
     * test in this repo can, which is how it shipped the first time and how it
     * shipped again in the sibling.
     */
    await renderPanel({ description: "חנות מקוונת בשם 'Urban Supply'" });
    const rows = screen.getAllByTestId('provenance-row');
    const row = rows.find((r) => within(r).queryByText('What you sell'));
    const isolate = row!.querySelector('bdi');
    expect(isolate).not.toBeNull();
    expect(isolate).toHaveAttribute('dir', 'auto');
  });
});
