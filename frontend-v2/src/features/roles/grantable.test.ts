import { describe, expect, it } from 'vitest';

import { roleSchema } from '@/api/contracts/roles';

import { grantableRoles } from './grantable';

const role = (id: string, features: string[], builtinKey: string | null = null) =>
  roleSchema.parse({ id, name: id, features, builtinKey, isSystem: builtinKey !== null });

const OWNER = role('owner', ['*'], 'owner');
const ADMIN = role('admin', ['crm:contacts:read', 'billing:invoices:read'], 'admin');
const AGENT = role('agent', ['crm:contacts:read'], 'agent');
const DEPT = role('dept', ['conversation:messages:*']);
const ROLES = [OWNER, ADMIN, AGENT, DEPT];
const CATALOG = [
  'crm:contacts:read',
  'billing:invoices:read',
  'conversation:messages:read',
  'conversation:messages:reply',
];
const holding =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);
const ids = (roles: readonly { id: string }[]) => roles.map((r) => r.id);

describe('★★ the invite offers only roles the viewer may give (auth 679b8812)', () => {
  it('a role whose every permission they hold; never Owner for a non-owner', () => {
    const viewer = { has: holding('crm:contacts:read'), roleKey: 'admin' };
    expect(ids(grantableRoles(ROLES, viewer, CATALOG))).toEqual(['agent']);
  });

  it('a pattern expands against the catalogue - held in full, it is offered', () => {
    const viewer = {
      has: holding(
        'crm:contacts:read',
        'conversation:messages:read',
        'conversation:messages:reply',
      ),
      roleKey: 'admin',
    };
    expect(ids(grantableRoles(ROLES, viewer, CATALOG))).toEqual(['agent', 'dept']);
    const short = { has: holding('crm:contacts:read', 'conversation:messages:read') };
    expect(ids(grantableRoles(ROLES, short, CATALOG))).toEqual(['agent']);
  });

  it('an Owner (or a platform admin) may give every role, Owner included', () => {
    expect(ids(grantableRoles(ROLES, { has: () => false, roleKey: 'owner' }, CATALOG))).toEqual(
      ids(ROLES),
    );
    expect(
      ids(grantableRoles(ROLES, { has: () => false, roleKey: 'SYSTEM_ADMIN' }, CATALOG)),
    ).toEqual(ids(ROLES));
  });

  it('★ unknown is not an Owner: holding everything, an unread role key still hides Owner', () => {
    const everything = { has: () => true, roleKey: null };
    expect(ids(grantableRoles(ROLES, everything, CATALOG))).toEqual(['admin', 'agent', 'dept']);
  });

  it('no catalogue: a pattern cannot be checked here, so it is offered and the server decides', () => {
    expect(ids(grantableRoles(ROLES, { has: holding('crm:contacts:read') }, null))).toEqual([
      'agent',
      'dept',
    ]);
  });
});
