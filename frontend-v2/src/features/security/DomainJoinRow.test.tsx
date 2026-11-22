import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import he from '@/i18n/messages/he/security.json';

const setDomainJoin = vi.hoisted(() => vi.fn());
vi.mock('./domain-join-actions', () => ({ setDomainJoin }));

const { DomainJoinRow } = await import('./DomainJoinRow');

const show = (join: { domain: string; joinByDomain: boolean; publicDomain: boolean }) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ security: he }}>
      <DomainJoinRow join={join} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  setDomainJoin.mockReset().mockResolvedValue('saved');
});

describe('★★ הצטרפות לפי דומיין', () => {
  it('★★ the admin’s own domain, isolated left-to-right, and a switch that saves', async () => {
    show({ domain: 'aviv.co.il', joinByDomain: false, publicDomain: false });
    const line = screen.getByTestId('domain-join-line');
    expect(line).toHaveTextContent('מי שנרשם עם מייל של aviv.co.il מצטרף לארגון כנציג.');
    expect(line.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
    await userEvent.click(screen.getByTestId('domain-join-switch'));
    await waitFor(() => expect(setDomainJoin).toHaveBeenCalledWith(true));
    expect(screen.getByTestId('domain-join-switch')).toBeChecked();
  });

  it('⚠⚠ a public mail domain: shown, off, not switchable, and why', () => {
    show({ domain: 'gmail.com', joinByDomain: true, publicDomain: true });
    expect(screen.getByTestId('domain-join-switch')).toBeDisabled();
    expect(screen.getByTestId('domain-join-switch')).not.toBeChecked();
    expect(screen.getByTestId('domain-join-line')).toHaveTextContent(
      'gmail.com הוא שירות מייל ציבורי, ולכן אי אפשר להצטרף לפיו.',
    );
  });

  it('⚠ refused: the switch goes back, and says so', async () => {
    setDomainJoin.mockResolvedValue('failed');
    show({ domain: 'aviv.co.il', joinByDomain: true, publicDomain: false });
    await userEvent.click(screen.getByTestId('domain-join-switch'));
    expect(await screen.findByTestId('domain-join-failed')).toHaveTextContent(he.domainJoin.failed);
    expect(screen.getByTestId('domain-join-switch')).toBeChecked();
  });
});

describe('★ the domain taken by another organization (409 domain_taken)', () => {
  it('says so, and the switch goes back', async () => {
    setDomainJoin.mockResolvedValue('taken');
    show({ domain: 'aviv.co.il', joinByDomain: false, publicDomain: false });
    await userEvent.click(screen.getByTestId('domain-join-switch'));
    expect(await screen.findByTestId('domain-join-failed')).toHaveTextContent(
      'aviv.co.il כבר משויך לארגון אחר, ולכן אי אפשר להפעיל כאן הצטרפות לפיו.',
    );
    expect(screen.getByTestId('domain-join-switch')).not.toBeChecked();
  });
});
