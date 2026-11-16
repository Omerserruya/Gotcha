import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aiCarries, conversationRowSchema, conversationRowsSchema } from '@/api/contracts/inbox';
import { rowOwner } from '@/features/mobile/inbox/row-owner';

import { menuPlan } from './queue-menu-rules';

/**
 * Prod, 2026-11-16: a conversation with `handledBy: 'sandbox'` failed the
 * contract, and the one row failed the whole queue for Smoovee, Mineraz and
 * Urban Supply ("Response did not match contract at: data.1.handledBy").
 */

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: 'OPEN',
  handledBy: 'ai_agent',
  assignedAgentId: null,
  isHandedOver: false,
  lastMessageAt: '2026-11-16T08:00:00.000Z',
  ...over,
});

describe('★★ every word the backend writes into handledBy parses', () => {
  it.each(['ai_agent', 'flow', 'human', 'awaiting_approval', 'sandbox'])('%s', (word) => {
    expect(conversationRowSchema.parse(row({ handledBy: word })).handledBy).toBe(word);
  });

  it('★★ a word nobody has named yet reads as null, never a failed row', () => {
    expect(conversationRowSchema.parse(row({ handledBy: 'robot_v2' })).handledBy).toBeNull();
    expect(conversationRowSchema.parse(row({ handledBy: 42 })).handledBy).toBeNull();
    expect(conversationRowSchema.parse(row({ handledBy: undefined })).handledBy).toBeNull();
  });

  it('★ lastMessageDirection degrades the same way', () => {
    expect(conversationRowSchema.parse(row({ lastMessageDirection: 'SIDEWAYS' })).lastMessageDirection).toBeNull();
  });
});

describe('★★ one bad row never fails the list', () => {
  it('the prod shape: rows 1 and 2 with words the old contract refused, and the page reads', () => {
    const rows = conversationRowsSchema.parse([
      row({ id: 'a' }),
      row({ id: 'b', handledBy: 'sandbox' }),
      row({ id: 'c', handledBy: 'awaiting_approval' }),
      row({ id: 'd', handledBy: 'something_new' }),
    ]);
    expect(rows.map((r) => [r.id, r.handledBy])).toEqual([
      ['a', 'ai_agent'],
      ['b', 'sandbox'],
      ['c', 'awaiting_approval'],
      ['d', null],
    ]);
  });

  it('★ a row broken some other way is left out; the rest stay', () => {
    const rows = conversationRowsSchema.parse([row({ id: 'a' }), row({ id: undefined }), row({ id: 'c', status: 'LIMBO' })]);
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('★★ the queue page the inbox asks for parses with it, end to end', async () => {
    get.mockReset().mockImplementation(async () => {
      throw new Error('not this one');
    });
    const { loadInbox } = await import('./load-inbox');
    await loadInbox(undefined, undefined, 'queue').catch(() => undefined);
    const call = get.mock.calls.find(([args]) => (args as { endpoint: { path: string } }).endpoint.path.includes('/conversations'));
    expect(call).toBeDefined();
    const payload = (call![0] as { payload: { parse: (v: unknown) => { data: { id: string; handledBy: unknown }[] } } }).payload;
    const page = payload.parse({
      data: [row({ id: 'a' }), row({ id: 'b', handledBy: 'sandbox' }), row({ id: 'x', status: 'LIMBO' })],
      page: { limit: 25, hasMore: false, nextCursor: null },
    });
    expect(page.data.map((r) => [r.id, r.handledBy])).toEqual([
      ['a', 'ai_agent'],
      ['b', 'sandbox'],
    ]);
  });
});

describe('★★ and each reads sensibly', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('aiCarries: the AI answering, paused on an approval, or a test chat', () => {
    expect(['ai_agent', 'awaiting_approval', 'sandbox'].every(aiCarries)).toBe(true);
    expect([null, 'flow', 'human', 'robot'].some(aiCarries)).toBe(false);
  });

  it('phone row: awaiting approval says so; a sandbox chat is GOTCHA', () => {
    const owner = (handledBy: string | null) =>
      rowOwner(conversationRowSchema.parse(row({ handledBy })), 'me', []);
    expect(owner('awaiting_approval')).toEqual({ kind: 'approval', tone: 'warn' });
    expect(owner('sandbox')).toEqual({ kind: 'gotcha', tone: 'ai' });
    expect(owner('ai_agent')).toEqual({ kind: 'gotcha', tone: 'ai' });
    expect(owner('robot')).toBeNull();
  });

  it('the menu treats the AI’s pauses as the AI driving (Stop AI, not Assign to me)', () => {
    const viewer = { meId: 'me', role: 'ADMIN', hasColleagues: true };
    for (const handledBy of ['sandbox', 'awaiting_approval']) {
      const plan = menuPlan([{ id: 'c1', status: 'OPEN', assignedAgentId: null, handledBy }], viewer);
      expect(plan.stopAi).toEqual(['c1']);
      expect(plan.assignToMe).toEqual([]);
    }
  });
});
