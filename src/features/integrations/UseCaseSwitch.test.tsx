import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/business-core.json';

/* The write is a spy: nothing here changes a tenant's business model. */
const setUseCase = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ setUseCase }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { UseCaseSwitch } from './UseCaseSwitch';

const show = (current: 'ecommerce' | 'leads' | 'both' | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ 'business-core': messages }}>
      <UseCaseSwitch current={current} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  setUseCase.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe('★★ 14b — "Your business runs on", live', () => {
  it('the chosen one is marked (02: dark); unset marks none and says so', () => {
    const one = show('both');
    expect(screen.getByTestId('core-use-case-both')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('core-use-case-leads')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Changing it adds or hides parts below')).toBeInTheDocument();
    one.unmount();
    show(null);
    expect(
      screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false'),
    ).toBe(true);
    expect(screen.getByTestId('core-use-case-unset')).toBeInTheDocument();
  });

  it('a press writes it and re-reads the page; the same one writes nothing', async () => {
    const user = userEvent.setup();
    show('ecommerce');
    await user.click(screen.getByTestId('core-use-case-ecommerce'));
    expect(setUseCase).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('core-use-case-leads'));
    expect(setUseCase).toHaveBeenCalledWith('leads');
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal is said; nothing moves', async () => {
    setUseCase.mockResolvedValue({ ok: false, reason: 'forbidden' });
    const user = userEvent.setup();
    show('ecommerce');
    await user.click(screen.getByTestId('core-use-case-both'));
    expect(screen.getByTestId('core-use-case-problem')).toHaveTextContent('permission');
    expect(refresh).not.toHaveBeenCalled();
  });
});
