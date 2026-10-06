import { describe, expect, it } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';

import { gridRows, levelOf, levelsOf, rowChanged, withLevel } from './role-grid';

const def = (key: string, domain: string, scoped = false): PermissionDef => {
  const [feature, subFeature, action] = key.split(':') as [string, string, string];
  return { key, domain, feature, subFeature, action, scoped, displayName: key, description: '' };
};

const CATALOG = [
  def('conversation:messages:read', 'conversation', true),
  def('conversation:messages:reply', 'conversation', true),
  def('conversation:messages:assign', 'conversation', true),
  def('crm:contacts:read', 'crm'),
  def('crm:contacts:update', 'crm'),
  def('ai:employees:read', 'ai'),
  def('ai:employees:update', 'ai'),
  def('ai:employees:create', 'ai'),
  def('ai:employees:delete', 'ai'),
  def('settings:roles:manage', 'settings'),
];

const rows = gridRows(CATALOG);
const row = (id: string) => rows.find((r) => r.id === id)!;

describe('★ 12c - ladders where the actions are a ladder, actions where they are jobs', () => {
  it('conversation:messages is actions; crm:contacts and ai:employees are levels', () => {
    expect(row('conversation:messages').ladder).toBeNull();
    expect(levelsOf(row('crm:contacts'))).toEqual(['none', 'view', 'edit']);
    expect(levelsOf(row('ai:employees'))).toEqual(['none', 'view', 'edit', 'manage']);
    expect(levelsOf(row('settings:roles'))).toEqual(['none', 'manage']);
  });

  it('a level holds the ones below it', () => {
    const next = withLevel(row('ai:employees'), 'manage', []);
    expect([...next].sort()).toEqual([
      'ai:employees:create',
      'ai:employees:delete',
      'ai:employees:read',
      'ai:employees:update',
    ]);
    expect(levelOf(row('ai:employees'), new Set(next))).toBe('manage');
  });

  it('★ a mix no level describes is null, never rounded', () => {
    expect(levelOf(row('crm:contacts'), new Set(['crm:contacts:update']))).toBeNull();
  });

  it('setting a level leaves every other row alone', () => {
    const before = ['conversation:messages:reply', 'crm:contacts:read'];
    expect(withLevel(row('crm:contacts'), 'none', before)).toEqual(['conversation:messages:reply']);
  });

  it('★ a ladder the catalogue no longer fits is drawn as actions', () => {
    const drifted = gridRows([def('crm:contacts:read', 'crm'), def('crm:contacts:merge', 'crm')]);
    expect(drifted[0]!.ladder).toBeNull();
  });

  it('a row changed from the source is the one whose holdings differ', () => {
    const a = new Set(['crm:contacts:read']);
    expect(rowChanged(row('crm:contacts'), a, new Set(['crm:contacts:read']))).toBe(false);
    expect(rowChanged(row('crm:contacts'), a, new Set())).toBe(true);
  });

  it('scope belongs to rows whose permissions take it', () => {
    expect(row('conversation:messages').scoped).toBe(true);
    expect(row('crm:contacts').scoped).toBe(false);
  });
});
