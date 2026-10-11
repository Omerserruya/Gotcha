import { describe, expect, it } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';

import {
  compactPatterns,
  expandPatterns,
  gridRows,
  keyLock,
  levelLock,
  levelOf,
  levelsOf,
  rowChanged,
  withLevel,
} from './role-grid';

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

const KEYS = CATALOG.map((p) => p.key);

describe('★★ a role’s patterns, on the grid and back (auth 30d610da)', () => {
  it('expands `*` to every key the catalogue lists', () => {
    expect(expandPatterns(['*'], KEYS)).toEqual(KEYS);
  });

  it('expands `area:sub:*` to its keys, beside the explicit ones, once each', () => {
    expect(
      expandPatterns(['conversation:messages:*', 'crm:contacts:read', 'crm:contacts:read'], KEYS),
    ).toEqual([
      'conversation:messages:read',
      'conversation:messages:reply',
      'conversation:messages:assign',
      'crm:contacts:read',
    ]);
  });

  it('keeps an exact key the catalogue does not list, rather than dropping it unasked', () => {
    expect(expandPatterns(['legacy.feature'], KEYS)).toEqual(['legacy.feature']);
  });

  it('★ untouched, a pattern goes back as the pattern - it keeps picking up new permissions', () => {
    const held = ['conversation:messages:*', 'crm:contacts:read'];
    expect(compactPatterns(expandPatterns(held, KEYS), held, KEYS)).toEqual(held);
    expect(compactPatterns(expandPatterns(['*'], KEYS), ['*'], KEYS)).toEqual(['*']);
  });

  it('★ narrowed, it goes back as the keys that are still on', () => {
    const held = ['conversation:messages:*'];
    const selected = ['conversation:messages:read', 'conversation:messages:reply'];
    expect(compactPatterns(selected, held, KEYS)).toEqual(selected);
  });

  it('a key added beside an untouched pattern is saved beside it', () => {
    const held = ['conversation:messages:*'];
    const selected = [...expandPatterns(held, KEYS), 'crm:contacts:update'];
    expect(compactPatterns(selected, held, KEYS)).toEqual([
      'conversation:messages:*',
      'crm:contacts:update',
    ]);
  });
});

describe('★★ ceiling and floor lock the grid (auth 30d610da)', () => {
  const limits = (ceiling: string[], floor: string[] = []) => ({
    ceiling: new Set(ceiling),
    floor: new Set(floor),
  });

  it('a ceiling key is locked as ceiling; a floor key as floor; anything else is free', () => {
    const l = limits(['ai:employees:delete'], ['settings:roles:manage']);
    expect(keyLock('ai:employees:delete', l)).toBe('ceiling');
    expect(keyLock('settings:roles:manage', l)).toBe('floor');
    expect(keyLock('crm:contacts:read', l)).toBeNull();
  });

  it('a level that would give a ceiling key is locked; the levels below it are not', () => {
    const l = limits(['ai:employees:delete']);
    expect(levelLock(row('ai:employees'), 'manage', l)).toBe('ceiling');
    expect(levelLock(row('ai:employees'), 'edit', l)).toBeNull();
    expect(levelLock(row('ai:employees'), 'none', l)).toBeNull();
  });

  it('a level that would take a floor key away is locked - "None" on Owner’s Roles row', () => {
    const l = limits([], ['settings:roles:manage']);
    expect(levelLock(row('settings:roles'), 'none', l)).toBe('floor');
    expect(levelLock(row('settings:roles'), 'manage', l)).toBeNull();
  });

  it('★ a custom role (`ceiling: []`) locks nothing', () => {
    const l = limits([]);
    for (const r of rows) {
      for (const level of levelsOf(r)) expect(levelLock(r, level, l)).toBeNull();
      for (const p of r.permissions) expect(keyLock(p.key, l)).toBeNull();
    }
  });
});
