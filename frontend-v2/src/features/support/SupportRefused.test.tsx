import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import { SupportProvider } from '@/support/support-context';

import { SupportRefused } from './SupportRefused';

const click = vi.fn();
const show = (inSupport: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <SupportProvider session={inSupport ? { tenantName: 'A', reason: null, endsAt: null } : null}>
        <SupportRefused kind="delete">
          <button type="button" onClick={click} data-testid="control">
            Disconnect
          </button>
        </SupportRefused>
      </SupportProvider>
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
  click.mockReset();
});

describe('★★ a control support mode refuses', () => {
  it('outside support mode: the control as it was', () => {
    show(false);
    expect(screen.queryByTestId('support-refused-delete')).toBeNull();
    expect(screen.getByTestId('control').closest('[inert]')).toBeNull();
  });

  it('★★ in support mode: still drawn, inert, and said', () => {
    show(true);
    const wrap = screen.getByTestId('support-refused-delete');
    expect(wrap).toHaveTextContent('Not allowed in support mode.');
    // Drawn - what the workspace holds stays readable - but nothing in it can act.
    expect(screen.getByTestId('control').closest('[inert]')).not.toBeNull();
  });
});
