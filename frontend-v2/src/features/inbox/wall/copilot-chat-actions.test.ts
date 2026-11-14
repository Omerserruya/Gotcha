import { beforeEach, describe, expect, it, vi } from 'vitest';

/* A billed model call and a private thread: `serverApi` is mocked and records what would be asked. */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

import { ApiError } from '@/api/client/api-error';
import { copilotThreadSchema } from '@/api/contracts/copilot-chat';

import { askCopilotChat, clearCopilotChat, readCopilotChat } from './copilot-chat-actions';

const refused = (status: number, code: string) =>
  new ApiError({
    kind: 'conflict',
    status,
    code,
    method: 'POST',
    route: '/api/ai-assist/c1/chat',
  } as never);
const parseWith = (method: 'get' | 'post' | 'delete', body: unknown) =>
  api[method].mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
    r.payload.parse(body),
  );

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('★★ the side chat on the wire', () => {
  it('reads the thread at /api/ai-assist/<id>/chat; a turn it cannot read is dropped, an empty draft is none', async () => {
    parseWith('get', {
      turns: [
        { id: '1', role: 'agent', text: 'Where is it?', at: 'x' },
        { id: '2', role: 'copilot', text: 'Shipped.', draft: '  ', at: 'x' },
        { id: '3', role: 'system', text: 'not ours', at: 'x' },
      ],
      maxTurns: 20,
    });
    const read = await readCopilotChat('c1');
    expect(api.get.mock.calls[0]![0].endpoint.path).toBe('/api/ai-assist/c1/chat');
    expect(read).toEqual({
      ok: true,
      turns: [
        { id: '1', role: 'agent', text: 'Where is it?', draft: null, at: 'x' },
        { id: '2', role: 'copilot', text: 'Shipped.', draft: null, at: 'x' },
      ],
    });
  });

  it('asks with the message and the agent’s locale, and no history (the server keeps it)', async () => {
    parseWith('post', { reply: 'Hi', text: 'Hi', turns: [] });
    await askCopilotChat('c1', '  Can we refund?  ', 'he');
    const sent = api.post.mock.calls[0]![0] as { body: unknown; endpoint: { path: string } };
    expect(sent.endpoint.path).toBe('/api/ai-assist/c1/chat');
    expect(sent.body).toEqual({ message: 'Can we refund?', locale: 'he' });
  });

  it('★ an empty or over-long message never leaves', async () => {
    expect(await askCopilotChat('c1', '   ', 'en')).toEqual({ ok: false, reason: 'empty' });
    expect(await askCopilotChat('c1', 'x'.repeat(4001), 'en')).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'COPILOT_CHAT_BUSY', 'busy'],
    [400, 'NO_AI_EMPLOYEE', 'no_ai_employee'],
    [400, 'MESSAGE_TOO_LONG', 'too_long'],
    [400, 'MESSAGE_REQUIRED', 'empty'],
    [502, 'COPILOT_CHAT_FAILED', 'failed'],
    // What requireEntitlement really sends (shared entitlement-resolver), not "FEATURE_NOT_ENTITLED".
    [403, 'PLAN_FEATURE_REQUIRED', 'not_on_plan'],
    [403, 'FEATURE_NOT_AVAILABLE', 'not_on_plan'],
  ] as const)('%s %s → %s', async (status, code, reason) => {
    api.post.mockRejectedValue(refused(status, code));
    expect(await askCopilotChat('c1', 'Hi', 'en')).toEqual({ ok: false, reason });
  });

  it('start over is a DELETE on the same thread', async () => {
    parseWith('delete', { turns: [] });
    expect(await clearCopilotChat('c1')).toEqual({ ok: true, turns: [] });
    expect(api.delete.mock.calls[0]![0].endpoint.path).toBe('/api/ai-assist/c1/chat');
  });

  it('maxTurns defaults to 20 when the route leaves it out', () => {
    expect(copilotThreadSchema.parse({ turns: [] }).maxTurns).toBe(20);
  });
});
