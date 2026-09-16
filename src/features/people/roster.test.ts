import { describe, expect, it } from 'vitest';

import type { AiEmployee, Member } from '@/api/contracts/people';
import type { AgentPresence } from '@/api/contracts/presence';

import { buildRoster, initialsOf } from './roster';

const member = (over: Partial<Member> = {}): Member => ({
  id: 'u1',
  name: 'Maya Levi',
  email: 'maya@avivco.il',
  isActive: true,
  departments: [],
  ...over,
});

const ai = (over: Partial<AiEmployee> = {}): AiEmployee => ({
  id: 'a1',
  name: 'Maya',
  role: 'customer_support',
  status: 'ACTIVE',
  ...over,
});

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Maya Levi')).toBe('ML');
    expect(initialsOf('Tomer Adler Ben David')).toBe('TD');
  });

  it('takes two letters from a single-word name', () => {
    // One letter reads as a truncation; two read as an avatar.
    expect(initialsOf('Maya')).toBe('MA');
  });

  it('works in Hebrew, which has no case', () => {
    expect(initialsOf('מאיה לוי')).toBe('מל');
  });

  it('does not split a surrogate pair in half', () => {
    // Slicing by code unit would produce a lone surrogate and render as "�".
    expect(Array.from(initialsOf('😀nomad'))).toHaveLength(2);
  });

  it('never returns an empty string', () => {
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('buildRoster', () => {
  it('puts people before AI employees rather than interleaving them', () => {
    // Sorted together by name, "Aaron" the AI would come first. They are
    // grouped because the two kinds answer different questions.
    const rows = buildRoster([member({ name: 'Zoe' })], [ai({ name: 'Aaron' })], [], 'en');
    expect(rows.map((r) => r.kind)).toEqual(['person', 'ai']);
  });

  it('keys the two collections apart when their ids collide', () => {
    const rows = buildRoster([member({ id: 'x' })], [ai({ id: 'x' })], [], 'en');
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('sorts dormant rows last within their own kind', () => {
    const rows = buildRoster(
      [member({ id: '1', name: 'Zoe' }), member({ id: '2', name: 'Adam', isActive: false })],
      [],
      [],
      'en',
    );
    expect(rows.map((r) => r.name)).toEqual(['Zoe', 'Adam']);
  });

  it('treats a paused AI employee as dormant', () => {
    const rows = buildRoster([], [ai({ status: 'PAUSED' })], [], 'en');
    expect(rows[0]!.dormant).toBe(true);
  });

  it('sorts Hebrew names in Hebrew, not by code point', () => {
    const rows = buildRoster(
      [member({ id: '1', name: 'תמר' }), member({ id: '2', name: 'אבי' })],
      [],
      [],
      'he',
    );
    expect(rows.map((r) => r.name)).toEqual(['אבי', 'תמר']);
  });

  it('leaves an unserved count null rather than reporting zero', () => {
    // "No open conversations" and "we were not told" are different facts and
    // only one of them is reassuring.
    const rows = buildRoster([member()], [ai()], [], 'en');
    expect(rows[0]!.openConversations).toBeNull();
    expect(rows[1]!.openConversations).toBeNull();
  });

  it('keeps a served zero as zero', () => {
    const rows = buildRoster([member({ openConversations: 0 })], [], [], 'en');
    expect(rows[0]!.openConversations).toBe(0);
  });

  it('attaches presence to the matching person', () => {
    const presence: AgentPresence[] = [
      { agentId: 'u1', status: 'AWAY', awayUntil: '2026-09-16T11:00:00Z' },
    ];
    const rows = buildRoster([member()], [], presence, 'en');
    expect(rows[0]!.presence).toBe('AWAY');
    expect(rows[0]!.awayUntil).toBe('2026-09-16T11:00:00Z');
  });

  it('gives an AI employee no presence at all', () => {
    // An employee has no presence concept, and inventing OFFLINE for one
    // would report it as absent when it is answering customers.
    const rows = buildRoster([], [ai()], [], 'en');
    expect(rows[0]!.presence).toBeNull();
  });

  it('leaves presence null for a person who has never sent a heartbeat', () => {
    const rows = buildRoster([member()], [], [], 'en');
    expect(rows[0]!.presence).toBeNull();
  });

  it('prefers the assigned role over the legacy enum', () => {
    const rows = buildRoster([member({ roleName: 'Owner', legacyRole: 'ADMIN' })], [], [], 'en');
    expect(rows[0]!.canDo).toBe('Owner');
  });

  it('falls back to the legacy enum when no role is assigned', () => {
    const rows = buildRoster([member({ legacyRole: 'ADMIN' })], [], [], 'en');
    expect(rows[0]!.canDo).toBe('ADMIN');
  });

  it('never invents a money limit', () => {
    // The policy engine scopes amounts per action kind, tenant-wide, with no
    // notion of a subject. A per-person figure is not something the backend
    // declined to send - it is something it cannot say.
    const rows = buildRoster([member({ roleName: 'Agent' })], [], [], 'en');
    expect(rows[0]!.canDo).not.toMatch(/\d/);
  });

  it('names a person by their email local part when they have no name yet', () => {
    const rows = buildRoster([member({ name: null })], [], [], 'en');
    expect(rows[0]!.name).toBe('maya');
  });

  it('falls back to the id rather than rendering an empty name', () => {
    const rows = buildRoster([member({ name: null, email: null })], [], [], 'en');
    expect(rows[0]!.name).toBe('u1');
  });

  it('drops a team whose name did not come back', () => {
    const rows = buildRoster(
      [member({ departments: [{ departmentId: 'd1', departmentName: null }] })],
      [],
      [],
      'en',
    );
    expect(rows[0]!.teams).toEqual([]);
  });

  it('keeps every team a person belongs to', () => {
    const rows = buildRoster(
      [
        member({
          departments: [
            { departmentId: 'd1', departmentName: 'Support' },
            { departmentId: 'd2', departmentName: 'Wholesale' },
          ],
        }),
      ],
      [],
      [],
      'en',
    );
    expect(rows[0]!.teams).toEqual(['Support', 'Wholesale']);
  });
});
