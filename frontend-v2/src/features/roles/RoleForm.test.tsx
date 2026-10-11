import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import type { Role } from '@/api/contracts/roles';
import messages from '@/i18n/messages/en/roles.json';

const { createRole, updateRole, resetRole } = vi.hoisted(() => ({
  createRole: vi.fn(),
  updateRole: vi.fn(),
  resetRole: vi.fn(),
}));
vi.mock('./actions', () => ({ createRole, updateRole, resetRole }));
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push, refresh }),
}));

import { RoleForm } from './RoleForm';

beforeEach(() => {
  createRole.mockReset();
  updateRole.mockReset();
  resetRole.mockReset();
  push.mockReset();
  refresh.mockReset();
});

/**
 * The catalogue's real shape: `feature:sub-feature:action`, three segments,
 * as `permission-catalog.ts`'s `p()` refuses to build anything else. The
 * previous fixture used two-segment keys the platform cannot produce.
 */
const def = (key: string, domain: string, displayName: string, scoped = false): PermissionDef => {
  const [feature, subFeature, action] = key.split(':') as [string, string, string];
  return { key, domain, feature, subFeature, action, scoped, displayName, description: '' };
};

const PERMISSIONS = [
  def('conversation:messages:read', 'conversation', 'Read Conversations', true),
  def('conversation:messages:reply', 'conversation', 'Reply to Conversations', true),
  def('crm:contacts:read', 'crm', 'Read Contacts'),
  def('crm:contacts:update', 'crm', 'Update Contacts'),
  def('customer:commerce:refund', 'customer', 'Issue Refunds', true),
  def('customer:commerce:return', 'customer', 'Process Returns', true),
];

const role = (id: string, name: string, features: string[]): Role => ({
  id,
  name,
  description: null,
  isSystem: true,
  builtinKey: null,
  features,
  memberCount: 1,
  editable: false,
  customized: false,
  ceiling: [],
  floor: [],
  defaults: null,
});

const ROLES: readonly Role[] = [
  role('r1', 'Agent', ['conversation:messages:read', 'crm:contacts:read']),
  // Measured: two scoped wildcards beside explicit keys - the dangerous shape.
  role('r3', 'Department Manager', [
    'crm:contacts:read',
    'conversation:messages:*',
    'customer:commerce:*',
  ]),
  role('r2', 'Owner', ['*']),
];

/** The form; with a source, picked in "Start from" (12b's Duplicate is gone). */
const renderForm = (sourceId = '') => {
  const view = render(
    <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
      <RoleForm permissions={PERMISSIONS} roles={ROLES} />
    </NextIntlClientProvider>,
  );
  if (sourceId)
    fireEvent.change(screen.getByTestId('role-source'), { target: { value: sourceId } });
  return view;
};

describe('★ 12c - 02’s table on the approved mapping', () => {
  it('a ladder row is a level; separate jobs are actions', () => {
    renderForm();
    expect(screen.getByTestId('role-level-crm:contacts-edit')).toBeInTheDocument();
    expect(screen.getByTestId('role-action-customer:commerce:refund')).toBeInTheDocument();
    // Refund does not come bundled with return.
    expect(screen.queryByTestId('role-level-customer:commerce-edit')).toBeNull();
  });

  it('scope is the assignment’s on scoped rows; a money limit is "-"', () => {
    renderForm();
    expect(screen.getByTestId('role-row-customer:commerce')).toHaveTextContent('Per assignment');
    expect(screen.getByTestId('role-row-crm:contacts')).toHaveTextContent(/-$/);
  });

  it('sends the level’s actions and the toggled ones', async () => {
    createRole.mockResolvedValue({ ok: true, id: 'r9' });
    renderForm();
    await userEvent.type(screen.getByTestId('role-name'), 'Refunds desk');
    await userEvent.click(screen.getByTestId('role-level-crm:contacts-edit'));
    await userEvent.click(screen.getByTestId('role-action-customer:commerce:refund'));
    await userEvent.click(screen.getByTestId('role-save'));
    expect(createRole).toHaveBeenCalledWith({
      name: 'Refunds desk',
      description: '',
      features: ['crm:contacts:read', 'crm:contacts:update', 'customer:commerce:refund'],
    });
  });

  it('keeps Create unavailable without a name', () => {
    renderForm();
    expect(screen.getByTestId('role-save')).toBeDisabled();
  });
});

describe('★ Start from - a copy, compared, and changes marked', () => {
  it('seeds from the source and says the two are not linked', () => {
    renderForm('r1');
    expect(screen.getByTestId('role-level-crm:contacts-view')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('role-action-conversation:messages:read')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('role-source-hint')).toHaveTextContent(/does not link the two/i);
  });

  it('no change: no legend, and the card says it is the same', () => {
    renderForm('r1');
    expect(screen.queryByTestId('role-legend')).toBeNull();
    expect(screen.getByTestId('role-compared')).toHaveTextContent('The same as Agent so far.');
  });

  it('a change marks its row, shows the legend, and the card names it', async () => {
    renderForm('r1');
    await userEvent.click(screen.getByTestId('role-level-crm:contacts-edit'));
    expect(screen.getByTestId('role-row-crm:contacts')).toHaveAttribute('data-changed', 'yes');
    expect(screen.getByTestId('role-legend')).toHaveTextContent('● Changed from Agent');
    expect(screen.getByTestId('role-compared')).toHaveTextContent('CRM contactsView → Edit');
  });
});

describe('★ a role that grants by pattern is read-only, and Create is unavailable', () => {
  it('Owner: refused, and says why', async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r2');
    expect(screen.getByTestId('role-source-wildcard')).toHaveTextContent(
      /including permissions added later/i,
    );
    expect(screen.getByTestId('role-source-refused')).toHaveTextContent(
      /cannot be used as a starting point/i,
    );
    await userEvent.type(screen.getByTestId('role-name'), 'Copy');
    expect(screen.getByTestId('role-save')).toBeDisabled();
  });

  it('★ Department Manager: the rows show its patterns, nothing is seeded', async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r3');
    expect(screen.getByTestId('role-row-customer:commerce')).toHaveTextContent('All, by pattern');
    expect(screen.queryByTestId('role-action-customer:commerce:refund')).toBeNull();
    expect(screen.getByTestId('role-selected')).toHaveTextContent(/no permissions selected/i);
  });
});

describe('the two refusals need different actions', () => {
  it('tells someone to pick another name on 409', async () => {
    createRole.mockResolvedValue({ ok: false, reason: 'name_taken' });
    renderForm();
    await userEvent.type(screen.getByTestId('role-name'), 'Agent');
    await userEvent.click(screen.getByTestId('role-save'));
    expect(await screen.findByTestId('role-error')).toHaveTextContent(/choose another name/i);
  });

  it('★ does NOT blame the person for a catalogue mismatch', async () => {
    createRole.mockResolvedValue({ ok: false, reason: 'unknown_features' });
    renderForm();
    await userEvent.type(screen.getByTestId('role-name'), 'Refunds');
    await userEvent.click(screen.getByTestId('role-save'));
    const error = await screen.findByTestId('role-error');
    expect(error).toHaveTextContent(/not something you did/i);
    expect(error).toHaveTextContent(/nothing was created/i);
  });
});

describe('★ 12c - 02 starts from Agent, and says what differs from the start', () => {
  const withAgent: readonly Role[] = [
    // The platform's own key, lowercase (invite-role.service.ts: builtinKey "agent").
    { ...role('ra', 'Agent', ['conversation:messages:read']), builtinKey: 'agent' },
    role('r2', 'Owner', ['*']),
  ];
  it('no ?from=: Agent is chosen and seeded, and "Compared with Agent" is there', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
        <RoleForm permissions={PERMISSIONS} roles={withAgent} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('role-source')).toHaveValue('ra');
    expect(screen.getByTestId('role-compared')).toHaveTextContent('Agent');
  });

  it('Create role and Cancel sit in the bar at the form’s end', () => {
    renderForm();
    const bar = screen.getByTestId('role-bar');
    expect(bar).toContainElement(screen.getByTestId('role-save'));
    expect(bar).toHaveTextContent('Cancel');
  });
});

describe('★★ 12b Edit - one custom role, saved over itself', () => {
  const FINANCE: Role = {
    id: 'r7',
    name: 'Finance',
    description: 'Refunds and returns',
    isSystem: false,
    builtinKey: null,
    features: ['crm:contacts:read', 'customer:commerce:refund'],
    memberCount: 2,
    editable: true,
    customized: false,
    ceiling: [],
    floor: [],
    defaults: null,
  };
  const renderEdit = () =>
    render(
      <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
        <RoleForm permissions={PERMISSIONS} roles={[...ROLES, FINANCE]} editing={FINANCE} />
      </NextIntlClientProvider>,
    );

  it('seeded from the role - its name, words and capabilities; no "Start from"', () => {
    renderEdit();
    expect(screen.getByTestId('role-name')).toHaveValue('Finance');
    expect(screen.getByTestId('role-description')).toHaveValue('Refunds and returns');
    expect(screen.getByTestId('role-action-customer:commerce:refund')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByTestId('role-source')).toBeNull();
    expect(screen.getByTestId('role-compared')).toHaveTextContent('Nothing has changed yet.');
    expect(screen.getByTestId('role-save')).toHaveTextContent('Save changes');
  });

  it('a change is named against the role itself; Save sends it and goes back to the roles', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEdit();
    await userEvent.click(screen.getByTestId('role-action-customer:commerce:return'));
    expect(screen.getByTestId('role-compared')).toHaveTextContent('What changes in Finance');
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole).toHaveBeenCalledWith('r7', {
      name: 'Finance',
      description: 'Refunds and returns',
      features: ['crm:contacts:read', 'customer:commerce:refund', 'customer:commerce:return'],
      isSystem: false,
    });
    expect(push).toHaveBeenCalledWith('/settings/people/roles');
    expect(createRole).not.toHaveBeenCalled();
  });

  it('partly saved is said - and the form stays', async () => {
    updateRole.mockResolvedValue({ ok: false, reason: 'partial' });
    renderEdit();
    await userEvent.click(screen.getByTestId('role-save'));
    expect(screen.getByTestId('role-error')).toHaveTextContent(
      "The capabilities were saved; the name and description weren't.",
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe('★★ the grant ceiling, said on create and on edit (auth 679b8812)', () => {
  it('create: a role above your own names what you lack - nothing created', async () => {
    createRole.mockResolvedValue({
      ok: false,
      reason: 'above_own_role',
      missing: ['customer:commerce:refund'],
    });
    renderForm();
    await userEvent.type(screen.getByTestId('role-name'), 'Refunds');
    await userEvent.click(screen.getByTestId('role-save'));
    expect(await screen.findByTestId('role-error')).toHaveTextContent(
      `You can't give permissions you don't hold yourself: ${messages.form.row['customer:commerce']} · ${messages.form.action.refund}. Nothing was changed.`,
    );
  });

  it('edit: OWNER_ONLY in its sentence, and the form stays', async () => {
    updateRole.mockResolvedValue({ ok: false, reason: 'owner_only' });
    const custom: Role = { ...ROLES[0]!, id: 'r8', name: 'Desk', isSystem: false };
    render(
      <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
        <RoleForm permissions={PERMISSIONS} roles={[...ROLES, custom]} editing={custom} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByTestId('role-save'));
    expect(screen.getByTestId('role-error')).toHaveTextContent(messages.ceiling.ownerOnly);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('★★ a built-in role, edited within its limits (auth 30d610da)', () => {
  const P = [
    def('conversation:messages:read', 'conversation', 'Read Conversations', true),
    def('conversation:messages:reply', 'conversation', 'Reply to Conversations', true),
    def('crm:contacts:read', 'crm', 'Read Contacts'),
    def('crm:contacts:update', 'crm', 'Update Contacts'),
    def('settings:workspace:read', 'settings', 'View Workspace'),
    def('settings:workspace:update', 'settings', 'Update Workspace'),
    def('settings:roles:manage', 'settings', 'Manage Roles'),
    def('settings:billing:manage', 'settings', 'Manage Billing'),
    def('settings:billing:read', 'settings', 'View Billing'),
  ];
  const builtin = (over: Partial<Role>): Role => ({
    id: 'dm',
    name: 'Department Manager',
    description: null,
    isSystem: true,
    builtinKey: 'department_manager',
    features: [],
    memberCount: 1,
    editable: true,
    customized: false,
    ceiling: [],
    floor: [],
    defaults: [],
    ...over,
  });
  // The measured shape: two patterns' worth beside explicit keys, and a ceiling.
  const DM = builtin({
    features: ['conversation:messages:*', 'crm:contacts:read', 'settings:workspace:read'],
    ceiling: [
      'settings:billing:manage',
      'settings:billing:read',
      'settings:roles:manage',
      'settings:workspace:update',
    ],
  });
  const OWNER = builtin({
    id: 'owner',
    name: 'Owner',
    builtinKey: 'owner',
    features: ['*'],
    floor: ['settings:roles:manage', 'settings:billing:manage'],
  });
  const renderEditing = (role: Role) =>
    render(
      <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
        <RoleForm permissions={P} roles={[role]} editing={role} />
      </NextIntlClientProvider>,
    );
  /** The accessible description a control points at. */
  const describedBy = (el: HTMLElement) =>
    document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

  it('★ a ceiling key is greyed, says why (title + description), and never turns on', async () => {
    renderEditing(DM);
    const billing = screen.getByTestId('role-action-settings:billing:manage');
    expect(billing).toHaveAttribute('aria-disabled', 'true');
    expect(billing).toHaveAttribute('title', "This role can't have this");
    expect(describedBy(billing)).toBe("This role can't have this");
    expect(billing).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(billing);
    expect(billing).toHaveAttribute('aria-pressed', 'false');
    // A level that would give one is locked; the level below it is not.
    const wsEdit = screen.getByTestId('role-level-settings:workspace-edit');
    expect(wsEdit).toHaveAttribute('aria-disabled', 'true');
    expect(wsEdit).toHaveAttribute('title', "This role can't have this");
    await userEvent.click(wsEdit);
    expect(wsEdit).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('role-level-settings:workspace-view')).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByTestId('role-level-settings:workspace-view')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('★ wildcards are expanded: the keys a pattern covers today are on', () => {
    renderEditing(DM);
    for (const key of ['conversation:messages:read', 'conversation:messages:reply'])
      expect(screen.getByTestId(`role-action-${key}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('role-source-wildcard')).toBeNull();
    expect(screen.getByTestId('role-edit-patterns')).toHaveTextContent('conversation:messages:*');
  });

  it('★ the Owner’s floor: on, locked, says why - and "None" on its row is locked too', async () => {
    renderEditing(OWNER);
    const billing = screen.getByTestId('role-action-settings:billing:manage');
    expect(billing).toHaveAttribute('aria-pressed', 'true');
    expect(billing).toHaveAttribute('aria-disabled', 'true');
    expect(billing).toHaveAttribute('title', 'The Owner always keeps this');
    expect(describedBy(billing)).toBe('The Owner always keeps this');
    await userEvent.click(billing);
    expect(billing).toHaveAttribute('aria-pressed', 'true');
    const none = screen.getByTestId('role-level-settings:roles-none');
    expect(none).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(none);
    expect(screen.getByTestId('role-level-settings:roles-manage')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // `*` covers everything, and nothing else is locked on the Owner.
    expect(screen.getByTestId('role-action-settings:billing:read')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('role-action-settings:billing:read')).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('★ a custom role (`ceiling: []`) has nothing greyed by the role', () => {
    const custom = builtin({
      id: 'c',
      name: 'Desk',
      isSystem: false,
      builtinKey: null,
      features: ['crm:contacts:read'],
    });
    renderEditing(custom);
    const controls = screen
      .getByRole('table')
      .querySelectorAll('button[data-testid^="role-action-"], button[data-testid^="role-level-"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('role-name')).toHaveValue('Desk');
  });

  it('★ its name and description are shown, never offered (PATCH refuses a built-in)', () => {
    renderEditing(DM);
    expect(screen.queryByTestId('role-name')).toBeNull();
    expect(screen.queryByTestId('role-description')).toBeNull();
    expect(screen.getByTestId('role-name-fixed')).toHaveTextContent(
      messages.builtinRole.department_manager.name,
    );
    expect(screen.getByTestId('role-name-fixed')).toHaveAttribute(
      'title',
      messages.form.edit.builtinName,
    );
    expect(screen.getByTestId('role-save')).toBeEnabled();
  });

  it('★★ the PUT body: the full list, an untouched pattern as the pattern', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEditing(DM);
    await userEvent.click(screen.getByTestId('role-level-crm:contacts-edit'));
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole).toHaveBeenCalledWith('dm', {
      name: 'Department Manager',
      description: '',
      features: [
        'conversation:messages:*',
        'settings:workspace:read',
        'crm:contacts:read',
        'crm:contacts:update',
      ],
      isSystem: true,
    });
    expect(push).toHaveBeenCalledWith('/settings/people/roles');
  });

  it('★★ a narrowed pattern is saved as the keys still on', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEditing(DM);
    await userEvent.click(screen.getByTestId('role-action-conversation:messages:reply'));
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole.mock.calls[0]![1].features).toEqual([
      'conversation:messages:read',
      'crm:contacts:read',
      'settings:workspace:read',
    ]);
  });

  it('★ a ceiling key the role still holds (a stale row) starts off - the save never sends it', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEditing({ ...DM, features: [...DM.features, 'settings:roles:manage'] });
    expect(screen.getByTestId('role-level-settings:roles-manage')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole.mock.calls[0]![1].features).not.toContain('settings:roles:manage');
  });

  it('★ a floor key the Owner lacks (a stale row) starts on - the save always sends it', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEditing({ ...OWNER, features: ['crm:contacts:read'] });
    expect(screen.getByTestId('role-action-settings:billing:manage')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole.mock.calls[0]![1].features).toEqual(
      expect.arrayContaining(['settings:roles:manage', 'settings:billing:manage']),
    );
  });

  it('the Owner, untouched, is saved as `*` - not as today’s list', async () => {
    updateRole.mockResolvedValue({ ok: true });
    renderEditing(OWNER);
    await userEvent.click(screen.getByTestId('role-save'));
    expect(updateRole.mock.calls[0]![1].features).toEqual(['*']);
  });

  it.each([
    [
      'role_ceiling',
      { reason: 'role_ceiling', blocked: ['settings:roles:manage'] },
      `This role can never have these: ${messages.form.row['settings:roles']} · ${messages.form.action.manage}. Nothing was changed.`,
    ],
    [
      'owner_floor',
      { reason: 'owner_floor', missing: ['settings:billing:manage'] },
      `The Owner always keeps these: ${messages.form.row['settings:billing']} · ${messages.form.action.manage}. Nothing was changed.`,
    ],
    ['role_merged', { reason: 'role_merged' }, 'Admin is now part of Owner. Nothing was changed.'],
    [
      'system',
      { reason: 'system' },
      "Built-in roles can't be changed right now. Nothing was changed.",
    ],
  ])('★ %s is said in words, and the form stays', async (_, refusal, words) => {
    updateRole.mockResolvedValue({ ok: false, ...refusal });
    renderEditing(DM);
    await userEvent.click(screen.getByTestId('role-save'));
    expect(screen.getByTestId('role-error')).toHaveTextContent(words);
    expect(push).not.toHaveBeenCalled();
  });

  describe('★★ Reset to default', () => {
    it('absent while the role is as shipped', () => {
      renderEditing(DM);
      expect(screen.queryByTestId('role-reset')).toBeNull();
    });

    it('absent on a custom role, whatever `customized` says', () => {
      renderEditing(
        builtin({ id: 'c', name: 'Desk', isSystem: false, builtinKey: null, customized: true }),
      );
      expect(screen.queryByTestId('role-reset')).toBeNull();
    });

    it('once changed: asked first, then the POST, then the page reads the role again', async () => {
      resetRole.mockResolvedValue({ ok: true });
      renderEditing({ ...DM, customized: true });
      await userEvent.click(screen.getByTestId('role-reset'));
      expect(resetRole).not.toHaveBeenCalled();
      expect(screen.getByTestId('role-reset-ask')).toHaveTextContent(
        `Reset ${messages.builtinRole.department_manager.name} to its default permissions?`,
      );
      await userEvent.click(screen.getByTestId('role-reset-yes'));
      expect(resetRole).toHaveBeenCalledWith('dm');
      expect(refresh).toHaveBeenCalled();
      expect(updateRole).not.toHaveBeenCalled();
    });

    it('"Keep it as it is" sends nothing', async () => {
      renderEditing({ ...DM, customized: true });
      await userEvent.click(screen.getByTestId('role-reset'));
      await userEvent.click(screen.getByTestId('role-reset-cancel'));
      expect(resetRole).not.toHaveBeenCalled();
      expect(screen.queryByTestId('role-reset-ask')).toBeNull();
      expect(screen.getByTestId('role-reset')).toBeInTheDocument();
    });

    it('409 NOT_BUILTIN is said in words', async () => {
      resetRole.mockResolvedValue({ ok: false, reason: 'not_builtin' });
      renderEditing({ ...DM, customized: true });
      await userEvent.click(screen.getByTestId('role-reset'));
      await userEvent.click(screen.getByTestId('role-reset-yes'));
      expect(screen.getByTestId('role-error')).toHaveTextContent(
        messages.form.reset.error.not_builtin,
      );
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
