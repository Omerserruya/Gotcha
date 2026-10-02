import { describe, expect, it } from 'vitest';

import { isAdmin, menuPlan, type MenuRow } from './queue-menu-rules';

const row = (id: string, over: Partial<MenuRow> = {}): MenuRow => ({
  id,
  status: 'OPEN',
  assignedAgentId: null,
  ...over,
});
const agent = { meId: 'me', role: 'AGENT', hasColleagues: true };
const admin = { meId: 'me', role: 'ADMIN', hasColleagues: true };

describe('★★ an item is offered only where its route will act', () => {
  it('Assign to me: anything not already mine', () => {
    const plan = menuPlan([row('a'), row('b', { assignedAgentId: 'me' })], agent);
    expect(plan.assignToMe).toEqual(['a']);
  });

  it('⚠ and nothing at all when we could not read who is looking', () => {
    expect(menuPlan([row('a')], { ...agent, meId: null }).assignToMe).toEqual([]);
  });

  it('⚠⚠ Assign to someone: an agent only for what they hold — the route 403s the rest', () => {
    const plan = menuPlan(
      [
        row('mine', { assignedAgentId: 'me' }),
        row('theirs', { assignedAgentId: 'u2' }),
        row('free'),
      ],
      agent,
    );
    expect(plan.assignToSomeone).toEqual(['mine']);
  });

  it('★ an admin may reassign any of them', () => {
    expect(
      menuPlan([row('a'), row('b', { assignedAgentId: 'u2' })], admin).assignToSomeone,
    ).toEqual(['a', 'b']);
  });

  it('⚠ and nobody to assign to means no item', () => {
    expect(menuPlan([row('a')], { ...admin, hasColleagues: false }).assignToSomeone).toEqual([]);
  });

  it('Put back in the queue: held, by me or seen by an admin', () => {
    const rows = [
      row('mine', { assignedAgentId: 'me' }),
      row('theirs', { assignedAgentId: 'u2' }),
      row('free'),
    ];
    expect(menuPlan(rows, agent).release).toEqual(['mine']);
    expect(menuPlan(rows, admin).release).toEqual(['mine', 'theirs']);
  });

  it('Mark resolved: not what is already closed', () => {
    expect(menuPlan([row('a'), row('b', { status: 'CLOSED' })], agent).resolve).toEqual(['a']);
  });

  it('⚠⚠ Delete: ADMIN and SYSTEM_ADMIN only — and an UNREAD role is not admin', () => {
    expect(menuPlan([row('a')], agent).remove).toEqual([]);
    expect(menuPlan([row('a')], admin).remove).toEqual(['a']);
    expect(menuPlan([row('a')], { ...admin, role: 'SYSTEM_ADMIN' }).remove).toEqual(['a']);
    expect(menuPlan([row('a')], { ...admin, role: null }).remove).toEqual([]);
    expect(isAdmin('admin')).toBe(false);
  });
});
