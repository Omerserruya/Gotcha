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

beforeEach(() => {
  createRole.mockReset();
});

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
    id: 'r3',
    name: 'Department Manager',
    description: null,
    isSystem: true,
    builtinKey: 'DEPARTMENT_MANAGER',
    /*
     * The dangerous shape, measured on this database: two scoped wildcards
     * beside explicit keys. A grid renders the explicit ones correctly and
     * drops the patterns — so it looks RIGHT while being destructive.
     */
    features: ['conversations:read', 'conversation:messages:*', 'customer:commerce:*'],
    memberCount: 4,
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

describe('★ a role that grants by pattern is refused, not flattened', () => {
  it('refuses Owner and says why', async () => {
    /*
     * A wildcard is a standing instruction — "everything under this,
     * including permissions added later" — so ticking what it matches today
     * produces a role identical on the day it is saved and divergent from
     * then on, every time anyone adds a permission key.
     */
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r2');
    const refusal = screen.getByTestId('role-source-wildcard');
    expect(refusal).toHaveTextContent(/grants permissions by pattern/i);
    expect(refusal).toHaveTextContent(/including permissions added later/i);
    expect(screen.getByTestId('role-source-refused')).toHaveTextContent(
      /cannot be used as a starting point/i,
    );
  });

  it('★ refuses Department Manager, which is NOT the Owner case', async () => {
    /*
     * Seeded, ordinary, non-Owner, on every tenant that has it: two scoped
     * wildcards beside fourteen explicit keys. A grid would render the
     * explicit ones correctly and silently drop the patterns — so unlike
     * Owner, it would look right.
     */
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r3');
    expect(screen.getByTestId('role-source-wildcard')).toBeInTheDocument();
    // Names the patterns, so the merchant can see what cannot be expressed.
    expect(screen.getByTestId('role-source-wildcard')).toHaveTextContent(
      /conversation:messages:\*/,
    );
  });

  it('★ seeds NOTHING from a pattern role, including the keys it could match', async () => {
    // The explicit `conversations:read` is in the catalogue and would tick.
    // It must not: a partial seed is the flattening, one box at a time.
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r3');
    expect(screen.getByTestId('role-permission-conversations:read')).not.toBeChecked();
    expect(screen.getByTestId('role-selected')).toHaveTextContent(/no permissions selected/i);
  });

  it('still seeds normally from a role without patterns', async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByTestId('role-source'), 'r1');
    expect(screen.queryByTestId('role-source-wildcard')).toBeNull();
    expect(screen.getByTestId('role-permission-conversations:read')).toBeChecked();
  });
});
