import { describe, expect, it } from 'vitest';

import { rowOwner } from './row-owner';

const row = {
  status: 'OPEN' as const,
  handledBy: null,
  assignedAgentId: null,
  isHandedOver: false,
};
const colleagues = [{ id: 'u2', name: 'Tomer' }];

describe('rowOwner', () => {
  it('a closed conversation is resolved, whoever held it', () => {
    expect(rowOwner({ ...row, status: 'CLOSED', assignedAgentId: 'u1' }, 'u1', colleagues)).toEqual({
      kind: 'resolved',
      tone: 'ok',
    });
  });

  it('assigned to the viewer, then to a colleague by name', () => {
    expect(rowOwner({ ...row, assignedAgentId: 'u1' }, 'u1', colleagues)?.kind).toBe('mine');
    expect(rowOwner({ ...row, assignedAgentId: 'u2' }, 'u1', colleagues)).toEqual({
      kind: 'colleague',
      tone: 'mute',
      name: 'Tomer',
    });
  });

  it('an assignee the viewer cannot name says nothing, not a wrong name', () => {
    expect(rowOwner({ ...row, assignedAgentId: 'u9' }, 'u1', colleagues)).toBeNull();
  });

  it('handed over with nobody on it is waiting, ahead of who was driving it', () => {
    expect(rowOwner({ ...row, isHandedOver: true, handledBy: 'ai_agent' }, 'u1', [])?.kind).toBe(
      'waiting',
    );
  });

  it('the AI and a flow, and nobody at all', () => {
    expect(rowOwner({ ...row, handledBy: 'ai_agent' }, null, [])?.kind).toBe('gotcha');
    expect(rowOwner({ ...row, handledBy: 'flow' }, null, [])?.kind).toBe('flow');
    expect(rowOwner(row, null, [])).toBeNull();
  });
});
