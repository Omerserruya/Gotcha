import { describe, expect, it } from 'vitest';

import { rowOwner } from './row-owner';
import enMobile from '@/i18n/messages/en/mobile.json';
import heMobile from '@/i18n/messages/he/mobile.json';

const row = {
  status: 'OPEN' as const,
  handledBy: null,
  assignedAgentId: null,
  isHandedOver: false,
};
const colleagues = [{ id: 'u2', name: 'Tomer' }];

describe('rowOwner', () => {
  it('a closed conversation is resolved, whoever held it', () => {
    expect(rowOwner({ ...row, status: 'CLOSED', assignedAgentId: 'u1' }, 'u1', colleagues)).toEqual(
      {
        kind: 'resolved',
        tone: 'ok',
      },
    );
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

describe('★ one person: an unheld handoff is waiting for you, not "in queue" (2026-11-15)', () => {
  const handed = { ...row, isHandedOver: true };

  it('★★ one person: "waiting for you", still the warning tone', () => {
    expect(rowOwner(handed, 'u1', colleagues, true)).toEqual({ kind: 'waitingYou', tone: 'warn' });
  });

  it('★ a team keeps "waiting in queue"', () => {
    expect(rowOwner(handed, 'u1', colleagues)).toEqual({ kind: 'waiting', tone: 'warn' });
    expect(rowOwner(handed, 'u1', colleagues, false)).toEqual({ kind: 'waiting', tone: 'warn' });
  });

  it('★ only the unheld handoff changes: a held or resolved one reads as before', () => {
    expect(rowOwner({ ...handed, assignedAgentId: 'u1' }, 'u1', colleagues, true)?.kind).toBe(
      'mine',
    );
    expect(rowOwner({ ...handed, status: 'CLOSED' }, 'u1', colleagues, true)?.kind).toBe(
      'resolved',
    );
  });

  it('★ named in both languages', () => {
    expect(enMobile.inbox.owner).toMatchObject({ waitingYou: 'Waiting for you' });
    expect(heMobile.inbox.owner).toMatchObject({ waitingYou: 'ממתין לכם' });
  });
});
