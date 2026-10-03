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
  getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
    scroll?: boolean;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
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

/*
 * ⚠ THE REMOVE CONTROL IS MOCKED TO THROW.
 *
 * `RemovePermission` is now inside this panel, and it removes a permission from
 * a real person on a tenant that sends live traffic. Rendering it is fine;
 * pressing it is not, and the only way to be sure no test does is to make the
 * attempt fail loudly.
 */
vi.mock('./RemovePermission', () => ({
  RemovePermission: ({ featureName }: { featureName: string }) => (
    <button
      type="button"
      data-testid={`remove-${featureName}`}
      onClick={() => {
        throw new Error('a test must never press RemovePermission');
      }}
    >
      remove
    </button>
  ),
}));

/* The catalogue's own names, so a key is not what the reader sees. */
const CATALOG = [
  {
    key: 'commerce:refunds:write',
    domain: 'commerce',
    feature: 'refunds',
    subFeature: '',
    action: 'write',
    scoped: false,
    displayName: 'Issue refunds',
    description: '',
  },
];

const renderPanel = async (over: Partial<Person> = {}, permissions = CATALOG) =>
  render(await PersonPanel({ person: person(over), permissions }));

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
    // Said once, by 02's section head, rather than on every row.
    expect(screen.getByTestId('overrides')).toHaveTextContent(/Only for Tomer Adler, on top of/);
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

  it('draws 02’s workload line as "—": nothing stores a cap or auto-assign', async () => {
    // Searched the whole schema and every service — the only `maxConcurrent`
    // is a voice-gateway socket limit from an env var. So no number, ever.
    await renderPanel();
    const line = screen.getByTestId('person-workload');
    expect(line).toHaveTextContent('Most conversations at once—Gets new ones automatically—');
    expect(line).toHaveAttribute('title', expect.stringMatching(/no field/i));
  });

  it('says where passwords and sessions live instead of offering them', async () => {
    /*
     * Both are Authentik's. A button implies we did it, and when it fails the
     * merchant blames us for something we do not own.
     */
    await renderPanel();
    const elsewhere = screen.getByTestId('account-elsewhere');
    expect(elsewhere).toHaveTextContent(/identity provider, not in GOTCHA/i);
    // 02's three account actions are drawn, and none is a control.
    expect(screen.getByText('Reset password')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Sign out of all devices')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Deactivate')).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByRole('button', { name: /reset password|sign out|deactivate/i }),
    ).toBeNull();
  });
});

describe('★★ the catalogue’s name, not the permission key', () => {
  const granted = {
    feature: 'commerce:refunds:write',
    granted: true,
    reason: null,
    updatedBy: null,
    updatedAt: null,
  };

  it('★★ shows the display name where the catalogue has one', async () => {
    /*
     * `grant.feature` was rendered raw — `commerce:refunds:write` on the screen
     * a manager uses to decide what somebody may do. `displayName` has existed
     * for as long as the catalogue has.
     */
    await renderPanel({ grants: [granted] });

    expect(screen.getByText('Issue refunds')).toBeInTheDocument();
    expect(screen.queryByText('commerce:refunds:write')).toBeNull();
  });

  it('★★ shows the KEY for a permission the catalogue does not describe, and says so', async () => {
    /*
     * The opposite decision from the channel enum, deliberately. An override on
     * a permission the catalogue has never heard of is not noise — it is
     * somebody granting something the product cannot explain, and that is the
     * more interesting of the two states. Hiding the key would hide it.
     */
    await renderPanel({ grants: [{ ...granted, feature: 'mystery:thing:write' }] });

    expect(screen.getByText('mystery:thing:write')).toBeInTheDocument();
    expect(screen.getByTestId('uncatalogued-mystery:thing:write')).toHaveTextContent(
      /not in the catalogue/i,
    );
  });

  it('★ and no such caption where the name was found', async () => {
    await renderPanel({ grants: [granted] });
    expect(screen.queryByTestId('uncatalogued-commerce:refunds:write')).toBeNull();
  });

  it('★★ a failed catalogue read leaves keys and the caption, not blanks', async () => {
    // The catalogue degrades on its own: the person is the subject of this
    // screen and the names are decoration. Every row still says what it is.
    await renderPanel({ grants: [granted] }, []);

    expect(screen.getByText('commerce:refunds:write')).toBeInTheDocument();
    expect(screen.getByTestId('uncatalogued-commerce:refunds:write')).toBeInTheDocument();
  });
});

describe('★★ the remove path, drawn and never pressed', () => {
  const granted = {
    feature: 'commerce:refunds:write',
    granted: true,
    reason: null,
    updatedBy: null,
    updatedAt: null,
  };

  it('★★ offers a remove on an ADDED grant', async () => {
    // 12e's second path. The design describes it and only the ADD path was
    // mounted, on a different screen.
    await renderPanel({ grants: [granted] });
    expect(screen.getByTestId('remove-Issue refunds')).toBeInTheDocument();
  });

  it('★★ offers NO remove on a grant that is already a removal', async () => {
    /*
     * `granted: false` is a permission taken away. A remove control there is a
     * control for the state the reader is already looking at, and pressing it
     * would ask the platform to remove a removal.
     */
    await renderPanel({ grants: [{ ...granted, granted: false }] });
    expect(screen.queryByTestId(/^remove-/)).toBeNull();
    expect(screen.getByTestId('grants-removed')).toBeInTheDocument();
  });

  it('★ and none at all when there are no overrides', async () => {
    await renderPanel({ grants: [] });
    expect(screen.queryByTestId(/^remove-/)).toBeNull();
  });
});

describe('★ 12d — 02’s drawer', () => {
  const member = {
    id: 'u1',
    isActive: true,
    roleId: 'r1',
    roleName: 'Agent',
    departments: [{ departmentId: 'd1', departmentName: 'Support team' }],
    openConversations: 4,
  };

  it('the head’s chips, Details with "—" where there is no field, the role card', async () => {
    render(
      await PersonPanel({
        person: person(),
        permissions: CATALOG,
        member,
        roleDescription: 'Answers conversations in their teams',
      }),
    );
    expect(screen.getByTestId('person-open')).toHaveTextContent('4 open');
    expect(screen.getByText('Job title').nextElementSibling).toHaveTextContent('—');
    expect(screen.getByTestId('person-role')).toHaveTextContent(
      'AgentAnswers conversations in their teams · ',
    );
  });

  it('"+ Add permission" opens 12e over the drawer', async () => {
    await renderPanel();
    expect(screen.getByTestId('person-add-permission')).toHaveAttribute(
      'href',
      '/settings/people?person=u1&grant=1',
    );
  });
});

describe('★ 12d corrections (measurement of 9121d4f)', () => {
  it('"Extra permissions" is a section, and the footer’s Save is drawn not live', async () => {
    await renderPanel();
    expect(screen.getByTestId('overrides')).toHaveTextContent(/^Extra permissions/);
    expect(screen.getByTestId('person-save')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('person-save')).toHaveAttribute(
      'title',
      expect.stringMatching(/save themselves/i),
    );
  });
});
