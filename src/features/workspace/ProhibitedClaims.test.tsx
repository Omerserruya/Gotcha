import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';
import he from '@/i18n/messages/he/workspace.json';

import { ProhibitedClaims } from './ProhibitedClaims';

vi.mock('./actions', () => ({ saveProhibitedClaims: vi.fn() }));

/**
 * The duplicate label, asserted.
 *
 * The field's label and the submit button both read `t('add')` and both
 * rendered "Add a rule", one directly above the other. It was raised at the
 * start of the walkthrough and survived three rebuilds, because nothing
 * asserted it: a duplicate label is invisible to a type checker, to a test
 * that queries by role, and to a reader who already knows what it meant.
 */

function renderClaims(locale: 'en' | 'he' = 'en') {
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ workspace: locale === 'he' ? he : messages }}
    >
      <ProhibitedClaims claims={['Promise a delivery date the carrier has not given']} />
    </NextIntlClientProvider>,
  );
}

describe('★ the field names the thing and the button names the verb', () => {
  it('does not render the same string twice', () => {
    renderClaims();
    const button = screen.getByRole('button', { name: /^add$/i });
    const field = screen.getByLabelText(/new rule/i);

    expect(button).toBeInTheDocument();
    expect(field).toBeInTheDocument();
    // The assertion that would have caught it: the two texts must differ.
    expect(button.textContent?.trim()).not.toBe('New rule');
  });

  it('holds in Hebrew too, where the same key would duplicate identically', () => {
    renderClaims('he');
    const button = screen.getByRole('button', { name: /הוספה/ });
    expect(button).toBeInTheDocument();
    expect(screen.getByLabelText(/כלל חדש/)).toBeInTheDocument();
  });
});

describe('the list it was given', () => {
  it('renders an existing rule rather than an empty state', () => {
    renderClaims();
    expect(screen.getByText(/Promise a delivery date/i)).toBeInTheDocument();
  });
});
