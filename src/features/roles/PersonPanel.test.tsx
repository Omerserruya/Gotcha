import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { roleSchema, type Person } from '@/api/contracts/roles';
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
 * This tenant has zero grants, so none of this can be captured - which is
 * exactly when it is cheapest to get right.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'roles') =>
    createTranslator({ locale: 'en', messages: { roles: messages }, namespace }),
  getLocale: async () => 'en',
  getTimeZone: async () => 'Asia/Jerusalem',
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

/* Changing a role is a write on a real person: its own tests; here, what it is given. */
vi.mock('./ChangeRole', () => ({
  ChangeRole: (props: {
    current: { id: string; name: string } | null;
    scope: string | null;
    held: number;
    choices: readonly { id: string; name: string }[];
  }) => <span data-testid="change-role-props" data-props={JSON.stringify(props)} />,
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
          expiresAt: null,
          active: true,
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
          expiresAt: null,
          active: true,
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
          expiresAt: null,
          active: true,
        },
        {
          feature: 'customer:profile:export',
          granted: true,
          reason: null,
          updatedBy: null,
          updatedAt: null,
          expiresAt: null,
          active: true,
        },
      ],
    });
    expect(screen.getByTestId('grants-added')).toBeInTheDocument();
    expect(screen.getByTestId('grants-removed')).toBeInTheDocument();
  });
});

describe('what this panel does not claim', () => {
  it('★ 02: "Ends 30 Sep"; once past, muted "Ended 3 Oct" - the row stays, with Remove', async () => {
    await renderPanel({
      grants: [
        {
          feature: 'customer:export:run',
          granted: true,
          reason: null,
          updatedBy: null,
          updatedAt: null,
          expiresAt: '2026-09-30T20:59:59.000Z',
          active: true,
        },
        {
          feature: 'conversation:assign:any',
          granted: true,
          reason: null,
          updatedBy: null,
          updatedAt: null,
          expiresAt: '2026-10-03T20:59:59.000Z',
          active: false,
        },
      ],
    });
    expect(screen.getByTestId('grant-ends-customer:export:run')).toHaveTextContent('Ends');
    expect(screen.getByTestId('grant-ends-customer:export:run')).toHaveTextContent('30 Sep');
    expect(screen.getByTestId('grant-conversation:assign:any')).toHaveAttribute('data-ended');
    expect(screen.getByTestId('grant-ends-conversation:assign:any')).toHaveTextContent('Ended');
  });

  it('draws 02’s workload line as "-": nothing stores a cap or auto-assign', async () => {
    // Searched the whole schema and every service - the only `maxConcurrent`
    // is a voice-gateway socket limit from an env var. So no number, ever.
    await renderPanel();
    const line = screen.getByTestId('person-workload');
    expect(line).toHaveTextContent('Most conversations at once-Gets new ones automatically-');
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
    expiresAt: null,
    active: true,
  };

  it('★★ shows the display name where the catalogue has one', async () => {
    /*
     * `grant.feature` was rendered raw - `commerce:refunds:write` on the screen
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
     * a permission the catalogue has never heard of is not noise - it is
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
    expiresAt: null,
    active: true,
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

describe('★ 12d - 02’s drawer', () => {
  const member = {
    id: 'u1',
    isActive: true,
    roleId: 'r1',
    roleName: 'Agent',
    departments: [{ departmentId: 'd1', departmentName: 'Support team' }],
    openConversations: 4,
  };

  it('the head’s chips, Details with "-" where there is no field, the role card', async () => {
    render(
      await PersonPanel({
        person: person(),
        permissions: CATALOG,
        member,
        role: roleSchema.parse({
          id: 'r1',
          name: 'Support',
          description: 'Answers conversations in their teams',
          features: [],
        }),
      }),
    );
    expect(screen.getByTestId('person-open')).toHaveTextContent('4 open');
    expect(screen.getByText('Job title').nextElementSibling).toHaveTextContent('-');
    expect(screen.getByTestId('person-role')).toHaveTextContent(
      'SupportAnswers conversations in their teams · ',
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

describe('★★ 12d’s role - in the reader’s words, and changeable (auth 00d669a3)', () => {
  const builtin = (key: string, name: string) =>
    roleSchema.parse({ id: key, name, isSystem: true, builtinKey: key, features: ['*'] });
  const props = () =>
    JSON.parse(screen.getByTestId('change-role-props').getAttribute('data-props')!);

  it('a built-in role is said by its key from the catalogue - name and description', async () => {
    render(
      await PersonPanel({
        person: person({ roles: [{ roleId: 'agent', scope: 'TEAM' }] }),
        permissions: CATALOG,
        role: builtin('agent', 'Agent (platform)'),
        roles: [builtin('agent', 'Agent (platform)')],
      }),
    );
    expect(screen.getByTestId('person-role')).toHaveTextContent(
      /^AgentFront-line agent: handles their own conversations/,
    );
    expect(screen.getByTestId('person-role')).not.toHaveTextContent('(platform)');
  });

  it('Change is given every role in those words, what they hold now, and the one scope to keep', async () => {
    render(
      await PersonPanel({
        person: person({ roles: [{ roleId: 'agent', scope: 'TEAM' }] }),
        permissions: CATALOG,
        role: builtin('agent', 'Agent'),
        // The platform's names differ from the catalogue's, so which one is said shows.
        roles: [
          builtin('admin', 'ADMIN (platform)'),
          builtin('agent', 'AGENT (platform)'),
          roleSchema.parse({ id: 'w', name: 'Wholesale', features: [] }),
        ],
      }),
    );
    expect(props()).toEqual({
      userId: 'u1',
      personName: 'Tomer Adler',
      current: { id: 'agent', name: 'Agent' },
      scope: 'TEAM',
      held: 1,
      choices: [
        { id: 'admin', name: 'Admin' },
        { id: 'agent', name: 'Agent' },
        { id: 'w', name: 'Wholesale' },
      ],
    });
  });

  it('holding several: every one is counted (all are replaced) and no scope is carried', async () => {
    render(
      await PersonPanel({
        person: person({
          roles: [
            { roleId: 'a', scope: 'TEAM' },
            { roleId: 'b', scope: 'OWN' },
          ],
        }),
        permissions: CATALOG,
        roles: [],
      }),
    );
    expect(props()).toMatchObject({ held: 2, scope: null });
  });

  it('the roles list unread: Change is a status with why, never a control', async () => {
    render(await PersonPanel({ person: person(), permissions: CATALOG, roles: null }));
    expect(screen.queryByTestId('change-role-props')).toBeNull();
    expect(screen.getByText('Change')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Change')).toHaveAttribute(
      'title',
      "We couldn't read your roles just now.",
    );
  });

  it('no role read, a legacy enum: still said in the reader’s words', async () => {
    render(await PersonPanel({ person: person({ role: 'ADMIN' }), permissions: CATALOG }));
    expect(screen.getByTestId('person-role')).toHaveTextContent(/^Admin/);
  });
});
