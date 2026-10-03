import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import type { Role } from '@/api/contracts/roles';
import messages from '@/i18n/messages/en/roles.json';

const { createRole } = vi.hoisted(() => ({ createRole: vi.fn() }));
vi.mock('./actions', () => ({ createRole }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { RoleForm } from './RoleForm';

beforeEach(() => {
  createRole.mockReset();
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
});

const ROLES: readonly Role[] = [
  role('r1', 'Agent', ['conversation:messages:read', 'crm:contacts:read']),
  // Measured: two scoped wildcards beside explicit keys — the dangerous shape.
  role('r3', 'Department Manager', [
    'crm:contacts:read',
    'conversation:messages:*',
    'customer:commerce:*',
  ]),
  role('r2', 'Owner', ['*']),
];

const renderForm = (initialSourceId = '') =>
  render(
    <NextIntlClientProvider locale="en" messages={{ roles: messages }}>
      <RoleForm permissions={PERMISSIONS} roles={ROLES} initialSourceId={initialSourceId} />
    </NextIntlClientProvider>,
  );

describe('★ 12c — 02’s table on the approved mapping', () => {
  it('a ladder row is a level; separate jobs are actions', () => {
    renderForm();
    expect(screen.getByTestId('role-level-crm:contacts-edit')).toBeInTheDocument();
    expect(screen.getByTestId('role-action-customer:commerce:refund')).toBeInTheDocument();
    // Refund does not come bundled with return.
    expect(screen.queryByTestId('role-level-customer:commerce-edit')).toBeNull();
  });

  it('scope is the assignment’s on scoped rows; a money limit is "—"', () => {
    renderForm();
    expect(screen.getByTestId('role-row-customer:commerce')).toHaveTextContent('Per assignment');
    expect(screen.getByTestId('role-row-crm:contacts')).toHaveTextContent(/—$/);
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

describe('★ Start from — a copy, compared, and changes marked', () => {
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
