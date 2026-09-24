import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { languageShareSchema } from '@/api/contracts/language-share';
import messages from '@/i18n/messages/en/workspace.json';

import { Languages } from './Languages';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'workspace.languages') =>
    createTranslator({ locale: 'en', messages: { workspace: messages }, namespace }),
  getLocale: async () => 'en',
}));

/** As measured: he 76, en 12, one undetected. */
const MEASURED = {
  windowDays: 30,
  total: 89,
  rows: [
    { locale: 'he', conversations: 76, share: 85.4 },
    { locale: 'en', conversations: 12, share: 13.5 },
    { locale: null, conversations: 1, share: 1.1 },
  ],
};

const renderPanel = async (over: Record<string, unknown> = {}) =>
  render(
    await Languages({
      share: languageShareSchema.parse(MEASURED),
      systemLocale: 'he',
      myLocale: 'en',
      storedLanguage: 'he',
      ...over,
    } as Parameters<typeof Languages>[0]),
  );

describe('★ the reassurance comes before the numbers', () => {
  it('states the reply rule first', async () => {
    /*
     * A merchant who reads "12 conversations in English" before this sentence
     * spends the next paragraph worrying. The behaviour is already correct —
     * the reply language is decided per conversation on a non-negotiable
     * prompt rule — so the panel says so and then shows the mix.
     */
    await renderPanel();
    const replies = screen.getByTestId('languages-replies');
    expect(replies).toHaveTextContent(/in the language they wrote in/i);
    expect(replies).toHaveTextContent(/nothing on this screen changes it/i);
  });
});

describe('the mix, as measured', () => {
  it('names each language with its count and share', async () => {
    await renderPanel();
    const rows = screen.getAllByTestId('language-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/Hebrew.*76.*85\.4%/);
    expect(rows[1]).toHaveTextContent(/English.*12.*13\.5%/);
  });

  it('★ keeps the undetected conversation out of the list but in the total', async () => {
    await renderPanel();
    // Not a language, so not a row.
    expect(screen.getAllByTestId('language-row')).toHaveLength(2);
    // But counted, and said — dropping it silently leaves percentages that
    // do not add up against a total of 89.
    expect(screen.getByTestId('languages-undetected')).toHaveTextContent(/counted in the total/i);
  });

  it('★ withholds percentages on a sample too small to support them', async () => {
    await renderPanel({
      share: languageShareSchema.parse({
        windowDays: 30,
        total: 3,
        rows: [{ locale: 'he', conversations: 3, share: 100 }],
      }),
    });
    expect(screen.getByTestId('languages-thin')).toHaveTextContent(/too few conversations/i);
    expect(screen.getByTestId('language-row')).not.toHaveTextContent('%');
  });

  it('names a language the workspace does not store, as information', async () => {
    await renderPanel();
    const unstored = screen.getByTestId('languages-unstored');
    expect(unstored).toHaveTextContent(/English/);
    // Framed as a market signal, not a fault: replies went out correctly.
    expect(unstored).toHaveTextContent(/nothing is wrong/i);
  });

  it('says nothing about unstored languages when there are none', async () => {
    await renderPanel({
      share: languageShareSchema.parse({
        windowDays: 30,
        total: 76,
        rows: [{ locale: 'he', conversations: 76, share: 100 }],
      }),
    });
    expect(screen.queryByTestId('languages-unstored')).toBeNull();
  });
});

describe('★ three settings, told apart', () => {
  it('separates what GOTCHA writes from what this person reads', async () => {
    await renderPanel();
    expect(screen.getByTestId('languages-system')).toHaveTextContent(/Summaries.*Hebrew/);
    expect(screen.getByTestId('languages-mine')).toHaveTextContent(/You personally.*English/);
  });

  it('says the interface language is inherited when unset', async () => {
    await renderPanel({ myLocale: null });
    expect(screen.getByTestId('languages-mine')).toHaveTextContent(/see the workspace's/i);
  });

  it('names the reply-language setting that does not exist', async () => {
    await renderPanel();
    expect(screen.getByTestId('languages-not-storable')).toHaveTextContent(/not a setting yet/i);
  });
});

describe('a failed read is not an absence of conversations', () => {
  it('says we could not read them', async () => {
    await renderPanel({ share: null });
    expect(screen.getByTestId('languages-unavailable')).toHaveTextContent(/could not read/i);
    expect(screen.queryByTestId('languages-none')).toBeNull();
  });

  it('says there were none only when the window really is empty', async () => {
    await renderPanel({ share: languageShareSchema.parse({ windowDays: 30, total: 0, rows: [] }) });
    expect(screen.getByTestId('languages-none')).toHaveTextContent(/nothing to measure/i);
  });
});
