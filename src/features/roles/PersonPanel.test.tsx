import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Person } from '@/api/contracts/roles';
import messages from '@/i18n/messages/en/roles.json';

import { PersonPanel } from './PersonPanel';

/**
 * That a removal never reads like an absence.
 *
 * `UserFeatureGrant.granted: false` takes away something the person's role
 * gives, and it is **invisible by construction**: the roles screen shows
 * Agent allowing refunds, the person is listed as an Agent, and the person
 * cannot refund. Every screen tells the truth and the reader ends up wrong.
 *
 * This tenant has zero grants, so none of this can be captured — which is
 * exactly when it is cheapest to get right.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'roles') =>
    createTranslator({ locale: 'en', messages: { roles: messages }, namespace }),
}));

const person = (over: Partial<Person> = {}): Person => ({
  id: 'u1',
  name: 'Tomer Adler',
  email: 'tomer@example.com',
  role: 'AGENT',
  roles: [{ roleId: 'r1', scope: 'team' }],
  grants: [],
  permissions: ['conversation:messages:read'],
  scope: 'team',
  ...over,
});

const renderPanel = async (over: Partial<Person> = {}) =>
  render(await PersonPanel({ person: person(over) }));

describe('exceptions to a role', () => {
  it('says plainly when there are none', async () => {
    await renderPanel();
    expect(screen.getByTestId('overrides-none')).toHaveTextContent(
      /exactly what their role allows/i,
    );
  });

  it('shows an addition as something given on top', async () => {
    await renderPanel({
      grants: [
        {
          feature: 'billing:refund:create',
          granted: true,
          reason: 'covers weekends',
          updatedBy: 'maya',
          updatedAt: null,
        },
      ],
    });
    expect(screen.getByTestId('grants-added')).toHaveTextContent(/given on top of their role/i);
    expect(screen.getByTestId('grants-added')).toHaveTextContent(/covers weekends/i);
  });

  it('shows a removal as something TAKEN AWAY, not as a plain absence', async () => {
    /*
     * The whole point. Without this the person reads as a normal Agent, and
     * the one thing that makes them different is the thing nothing shows.
     */
    await renderPanel({
      grants: [
        {
          feature: 'billing:refund:create',
          granted: false,
          reason: 'pending review',
          updatedBy: 'maya',
          updatedAt: null,
        },
      ],
    });
    const removed = screen.getByTestId('grants-removed');
    expect(removed).toHaveTextContent(/taken away from what their role allows/i);
    expect(removed).toHaveTextContent(/pending review/i);
    // And it is not filed under additions.
    expect(screen.queryByTestId('grants-added')).toBeNull();
  });

  it('shows both directions at once', async () => {
    await renderPanel({
      grants: [
        {
          feature: 'billing:refund:create',
          granted: false,
          reason: null,
          updatedBy: null,
          updatedAt: null,
        },
        {
          feature: 'customer:profile:export',
          granted: true,
          reason: null,
          updatedBy: null,
          updatedAt: null,
        },
      ],
    });
    expect(screen.getByTestId('grants-added')).toBeInTheDocument();
    expect(screen.getByTestId('grants-removed')).toBeInTheDocument();
  });
});

describe('what this panel does not claim', () => {
  it('says an exception has no end date rather than offering one', async () => {
    // The design says "with who added them and when they end". `updatedBy`
    // exists; an end date does not.
    await renderPanel();
    expect(screen.getByTestId('overrides-no-expiry')).toHaveTextContent(/no end date/i);
  });

  it('renders no workload cap or auto-assign', async () => {
    // Searched the whole schema and every service — the only `maxConcurrent`
    // is a voice-gateway socket limit from an env var.
    await renderPanel();
    expect(document.body.textContent).not.toMatch(/workload|capacity|auto.?assign|at once/i);
  });

  it('says where passwords and sessions live instead of offering them', async () => {
    /*
     * Both are Authentik's. A button implies we did it, and when it fails the
     * merchant blames us for something we do not own.
     */
    await renderPanel();
    const elsewhere = screen.getByTestId('account-elsewhere');
    expect(elsewhere).toHaveTextContent(/identity provider, not in GOTCHA/i);
    expect(screen.queryByRole('button', { name: /reset password|revoke session/i })).toBeNull();
  });
});
