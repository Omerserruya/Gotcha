import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import messages from '@/i18n/messages/en/billing.json';
import { PermissionsProvider, type PermissionsStatus } from '@/permissions/permissions-context';
import type { PermissionString } from '@/permissions/permission-set';

import { ChangePlanGate } from './ChangePlanGate';

/**
 * Who may change the plan, and what they are told if they may not.
 *
 * The capture cannot cover this: it runs as one principal, who holds
 * `settings:billing:manage`. The refusal path and the unavailable path are
 * only reachable here.
 */

function renderGate({
  permissions = ['settings:billing:manage'],
  status = 'loaded' as PermissionsStatus,
  hasPaymentMethod = true,
  effectiveAt = '2027-09-08T00:00:00.000Z' as string | null,
} = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={{ billing: messages }}>
      <PermissionsProvider
        permissions={permissions as readonly PermissionString[]}
        status={status}
        tenantId="t1"
      >
        <ChangePlanGate effectiveAt={effectiveAt} hasPaymentMethod={hasPaymentMethod} />
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );
}

describe('the deferred date leads, and it carries the year', () => {
  it('states when a change would actually take effect', () => {
    renderGate();
    const note = screen.getByTestId('change-deferred');
    expect(note).toHaveTextContent(/end of your billing period/i);
    /*
     * Every change available to this tenant lands in September 2027. A bare
     * "8 September" is read as this year by everybody, so the year is
     * asserted PRESENT — not in any particular format.
     */
    expect(note).toHaveTextContent(/2027/);
  });

  it('says nothing about a date it does not have', () => {
    renderGate({ effectiveAt: null });
    expect(screen.queryByTestId('change-deferred')).toBeNull();
  });
});

describe('★ a scheduled change can be replaced but never cleared', () => {
  it('says so before the choice, not after it', () => {
    /*
     * `resumeSubscription` is the only revoke path and its cleanup is gated
     * on `changeType: "CANCEL"`. A scheduled downgrade cannot be removed —
     * `changePlan` upserts the same row, so another change REPLACES it, and
     * nothing returns the subscription to having none scheduled.
     */
    renderGate();
    const note = screen.getByTestId('change-irreversible');
    expect(note).toHaveTextContent(/cannot be called off here/i);
    // Replaceable, not merely irreversible — the distinction is the useful part.
    expect(note).toHaveTextContent(/choosing a different plan replaces it/i);
    // And it names the asymmetry, because a cancellation CAN be reversed.
    expect(note).toHaveTextContent(/only a cancellation can be reversed/i);
  });

  it('is shown even with no control on the screen yet', () => {
    // True today about a state the tenant could already be in, and not
    // contingent on us shipping the button.
    renderGate({ permissions: [] });
    expect(screen.getByTestId('change-irreversible')).toBeInTheDocument();
  });
});

describe('a missing card is named as a path, not a wall', () => {
  it('says the upgrade would be declined AND how to fix it', () => {
    renderGate({ hasPaymentMethod: false });
    const note = screen.getByTestId('change-no-card');
    expect(note).toHaveTextContent(/declined/i);
    // The recovery is real: the idempotency key is scoped to the payment
    // method so a retry after adding a card is not blocked.
    expect(note).toHaveTextContent(/add a card/i);
  });

  it('says nothing when a card is on file', () => {
    renderGate({ hasPaymentMethod: true });
    expect(screen.queryByTestId('change-no-card')).toBeNull();
  });
});

describe('the permission is explained, not hidden', () => {
  it('names the permission somebody needs to ask for', () => {
    renderGate({ permissions: [] });
    const note = screen.getByTestId('change-needs-permission');
    expect(note).toHaveTextContent(/Manage billing/i);
    // Hiding it would leave them hunting for a feature they were told exists.
    expect(note).toHaveTextContent(/ask/i);
  });

  it('says nothing to somebody who holds it', () => {
    renderGate({ permissions: ['settings:billing:manage'] });
    expect(screen.queryByTestId('change-needs-permission')).toBeNull();
  });

  it('does NOT refuse when permissions could not be loaded', () => {
    /*
     * `unavailable` is not an empty set. The backend remains the security
     * authority, so the worst case here is a refusal with an explanation —
     * which beats telling someone they lack a permission we never read.
     */
    renderGate({ permissions: [], status: 'unavailable' });
    expect(screen.queryByTestId('change-needs-permission')).toBeNull();
  });
});
