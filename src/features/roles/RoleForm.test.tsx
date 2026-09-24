import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import type { Role } from '@/api/contracts/roles';
import messages from '@/i18n/messages/en/roles.json';

import { RoleForm } from './RoleForm';

const { createRole } = vi.hoisted(() => ({ createRole: vi.fn() }));
vi.mock('./actions', () => ({ createRole }));

beforeEach(() => createRole.mockReset());

const permission = (key: string, domain: string, displayName: string): PermissionDef => ({
  key,
  domain,
  feature: key,
  subFeature: '',
  action: 'read',
  scoped: false,
  displayName,
  description: '',
});

const PERMISSIONS = [
  permission('conversations:read', 'conversations', 'See conversations'),
  permission('conversations:write', 'conversations', 'Reply to conversations'),
  permission('billing:refunds', 'billing', 'Issue refunds'),
];

const ROLES: readonly Role[] = [
  {
    id: 'r1',
    name: 'Agent',
    description: null,
    isSystem: true,
    builtinKey: 'AGENT',
    features: ['conversations:read'],
    memberCount: 3,
  },
  {
    id: 'r2',
    name: 'Owner',
    description: null,
    isSystem: true,
    // The wildcard role. One feature row, `*`, which `permissions.ts:37`
    // short-circuits to "yes" — so copying Owner copies one string that
    // means everything, and the checkbox list cannot represent it.
    builtinKey: 'OWNER',
    features: ['*'],
    memberCount: 1,
  },
];

const renderForm = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
      <RoleForm permissions={PERMISSIONS} roles={ROLES} />
    </NextIntlClientProvider>,
  );

describe('★ starting from a role copies it, and says that it copies', () => {
  it('seeds the selection from the source role', async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r1');
    expect(screen.getByTestId('role-permission-conversations:read')).toBeChecked();
    expect(screen.getByTestId('role-permission-conversations:write')).not.toBeChecked();
  });

  it('★ says the two are not linked afterwards', async () => {
    /*
     * "Start from" reads as a link and it is a copy. Somebody who later
     * widens Agent would reasonably expect this role to follow, and it will
     * not — `POST /roles` takes a feature list and stores no source.
     */
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r1');
    const hint = screen.getByTestId('role-source-hint');
    expect(hint).toHaveTextContent(/does not link the two/i);
    expect(hint).toHaveTextContent(/Agent/);
  });

  it('starts empty when no source is chosen', () => {
    renderForm();
    expect(screen.getByTestId('role-selected')).toHaveTextContent(/no permissions selected/i);
  });
});

describe('★ one checkbox per permission, not four levels', () => {
  it('renders a single control for each', () => {
    /*
     * `TenantRoleFeature` is `(roleId, feature)` — a permission is held or it
     * is not. The design draws None / View / Edit / Manage, and a control
     * offering four states would write three of them to the same value.
     */
    renderForm();
    const box = screen.getByTestId('role-permission-billing:refunds');
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('groups them by area, as the design asks', () => {
    renderForm();
    expect(screen.getAllByTestId('role-domain')).toHaveLength(2);
  });

  it('says plainly that the four levels do not exist', () => {
    renderForm();
    expect(screen.getByTestId('role-no-levels')).toHaveTextContent(
      /no None \/ View \/ Edit \/ Manage levels/i,
    );
  });

  it('★ says a refund permission carries no amount', () => {
    /*
     * There is no amount column on a role, a feature or a grant. The design's
     * "refunds up to ₪1,000" cannot be stored, enforced or displayed — and
     * this is the kind of absence an owner would otherwise learn from an
     * invoice.
     */
    renderForm();
    const note = screen.getByTestId('role-no-limits');
    expect(note).toHaveTextContent(/no amount stored anywhere/i);
    expect(note).toHaveTextContent(/may issue any refund/i);
  });
});

describe('the two refusals need different actions', () => {
  it('tells someone to pick another name on 409', async () => {
    createRole.mockResolvedValue({ ok: false, reason: 'name_taken' });
    renderForm();
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Agent');
    await userEvent.click(screen.getByTestId('role-save'));
    expect(await screen.findByTestId('role-error')).toHaveTextContent(/choose another name/i);
  });

  it('★ does NOT blame the person for a catalogue mismatch', async () => {
    /*
     * A 400 means the catalogue offered a key the server will not grant.
     * That is drift between two lists, and telling somebody to fix their
     * input would send them looking for a mistake they did not make.
     */
    createRole.mockResolvedValue({ ok: false, reason: 'unknown_features' });
    renderForm();
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Refunds');
    await userEvent.click(screen.getByTestId('role-save'));
    const error = await screen.findByTestId('role-error');
    expect(error).toHaveTextContent(/not something you did/i);
    expect(error).toHaveTextContent(/nothing was created/i);
  });
});

describe('the form will not submit nothing', () => {
  it('keeps Save unavailable without a name', () => {
    renderForm();
    expect(screen.getByTestId('role-save')).toBeDisabled();
  });

  it('sends the name, description and the selected features', async () => {
    createRole.mockResolvedValue({ ok: true, id: 'r9' });
    renderForm();
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Refunds desk');
    await userEvent.click(screen.getByTestId('role-permission-billing:refunds'));
    await userEvent.click(screen.getByTestId('role-save'));
    expect(createRole).toHaveBeenCalledWith({
      name: 'Refunds desk',
      description: '',
      features: ['billing:refunds'],
    });
  });
});

describe('★ the wildcard role cannot be copied into a checkbox list', () => {
  it('selects nothing the catalogue can show when starting from Owner', async () => {
    /*
     * Owner holds ONE feature row: `*`. `permissions.ts:37` short-circuits it
     * to "yes" for every key. So "start from Owner" seeds a selection of one
     * string that is not in the catalogue and means everything.
     *
     * The checkboxes therefore show nothing ticked, which is honest about
     * what this form can represent — and the count says one, which is what
     * would be SENT. A form that silently ticked all 63 would be creating a
     * different role from the one it copied.
     */
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r2');
    expect(screen.getByTestId('role-permission-billing:refunds')).not.toBeChecked();
    expect(screen.getByTestId('role-selected')).toHaveTextContent(/1 permission selected/i);
  });
});
