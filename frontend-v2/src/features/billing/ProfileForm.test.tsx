import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { billingProfileSchema } from '@/api/contracts/billing-profile';
import messages from '@/i18n/messages/en/billing.json';

/* Saving writes the workspace's billing record: a spy, always. */
const saveBillingProfile = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ saveBillingProfile }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { PROFILE_FORM_ID } from './profile-form';
import { ProfileForm } from './ProfileForm';

beforeEach(() => {
  saveBillingProfile.mockReset();
  refresh.mockReset();
});

const stored = billingProfileSchema.parse({
  billingName: 'Aviv & Co. Ltd',
  vatId: '515234781',
  billingAddress: '14 Ha’arba’a, Tel Aviv',
  billingCountry: 'IL',
  billingEmail: 'finance@example.com',
});
/* The overlay's footer Save, outside the form, submitting it by id - as on the page. */
const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <ProfileForm profile={stored} />
      <button type="submit" form={PROFILE_FORM_ID} data-testid="footer-save">
        Save details
      </button>
    </NextIntlClientProvider>,
  );

describe('★★ 17e - billing details, edited and saved (database only)', () => {
  it('seeded with what is stored; the footer Save sends ALL five, an emptied one as empty', async () => {
    saveBillingProfile.mockResolvedValue({ ok: true });
    show();
    expect(screen.getByTestId('profile-input-billingName')).toHaveValue('Aviv & Co. Ltd');
    await userEvent.clear(screen.getByTestId('profile-input-vatId'));
    await userEvent.clear(screen.getByTestId('profile-input-billingName'));
    await userEvent.type(screen.getByTestId('profile-input-billingName'), 'Aviv Ltd');
    expect(saveBillingProfile).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(saveBillingProfile).toHaveBeenCalledWith({
      billingName: 'Aviv Ltd',
      vatId: '',
      billingAddress: '14 Ha’arba’a, Tel Aviv',
      billingCountry: 'IL',
      billingEmail: 'finance@example.com',
    });
    expect(screen.getByTestId('profile-saved')).toHaveTextContent(
      'Saved. New invoices carry these details.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ['invalid_country', 'The country must be two letters, like IL.'],
    ['no_record', "There's no billing record to save these to yet"],
    ['forbidden', "You don't have permission to change billing details."],
    ['failed', 'Not saved. Try again.'],
  ])('%s: said in words; nothing claims it saved', async (reason, words) => {
    saveBillingProfile.mockResolvedValue({ ok: false, reason });
    show();
    await userEvent.click(screen.getByTestId('footer-save'));
    expect(screen.getByTestId('profile-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('profile-saved')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('PO and invoice language have no column: "-", with why - never an input', () => {
    show();
    const po = screen.getByText('Purchase order / reference').nextElementSibling;
    expect(po?.tagName).not.toBe('INPUT');
    expect(po).toHaveAttribute('title', 'GOTCHA has no field for this yet.');
  });
});
