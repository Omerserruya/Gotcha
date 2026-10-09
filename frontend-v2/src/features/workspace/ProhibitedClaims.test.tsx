import { render, screen, fireEvent } from '@testing-library/react';
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
    // The editing opens in place, from 02's "Add a rule".
    fireEvent.click(screen.getByTestId('claims-open'));
    const button = screen.getByRole('button', { name: /^add$/i });
    const field = screen.getByLabelText(/new rule/i);

    expect(button).toBeInTheDocument();
    expect(field).toBeInTheDocument();
    // The assertion that would have caught it: the two texts must differ.
    expect(button.textContent?.trim()).not.toBe('New rule');
  });

  it('holds in Hebrew too, where the same key would duplicate identically', () => {
    renderClaims('he');
    fireEvent.click(screen.getByTestId('claims-open'));
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

describe('★ 11 draws a read state; the editing opens in place', () => {
  it('the rules as bullets and "Add a rule" - no field, no Remove until it is opened', () => {
    renderClaims();
    expect(screen.queryByLabelText(/new rule/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
    expect(screen.getByTestId('claims-open')).toHaveTextContent('Add a rule');
  });
});
