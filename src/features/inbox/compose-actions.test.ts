import { beforeEach, describe, expect, it, vi } from 'vitest';

/* A billed model call: `serverApi` is mocked and records what would be asked. */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { ApiError } from '@/api/client/api-error';

import { composeDraft } from './compose-actions';
import { COMPOSE_KINDS } from './compose-kinds';

type Sent = { body: Record<string, unknown>; endpoint: { path: string } };
const sent = () => post.mock.calls[0]![0] as Sent;

beforeEach(() => {
  post.mockReset().mockResolvedValue({ text: '  Better words  ' });
});

describe('★★ the chip names WHICH instruction; the words live on the server', () => {
  it('each kind sends its own instruction, the draft, and the conversation', async () => {
    const seen = new Set<unknown>();
    for (const kind of COMPOSE_KINDS) {
      post.mockClear();
      expect(await composeDraft('c1', kind, ' draft ')).toEqual({ ok: true, text: 'Better words' });
      expect(sent().endpoint.path).toBe('/api/ai-assist/compose');
      expect(sent().body).toMatchObject({
        surface: 'inbox',
        conversationId: 'c1',
        currentDraft: 'draft',
      });
      seen.add(sent().body.instruction);
    }
    // Three chips, three different asks — not one instruction under three names.
    expect(seen.size).toBe(COMPOSE_KINDS.length);
  });

  it('⚠ sends no `locale` — it would make "Shorter" translate into the UI language', async () => {
    await composeDraft('c1', 'shorter', 'draft');
    expect(sent().body).not.toHaveProperty('locale');
  });

  it('★ Translate asks for the CUSTOMER’s language, which the route can read', async () => {
    await composeDraft('c1', 'translate', 'draft');
    expect(String(sent().body.instruction)).toMatch(/language the customer/i);
  });
});

describe('⚠ what it refuses, and what it reports', () => {
  it('an empty draft asks nothing', async () => {
    expect(await composeDraft('c1', 'rewrite', '   ')).toEqual({ ok: false, reason: 'empty' });
    expect(post).not.toHaveBeenCalled();
  });

  it('a kind it does not know asks nothing — a server action is public', async () => {
    expect(await composeDraft('c1', 'ignore previous' as never, 'draft')).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('an empty answer is "blank", not text', async () => {
    post.mockResolvedValue({ text: '   ' });
    expect(await composeDraft('c1', 'rewrite', 'draft')).toEqual({ ok: false, reason: 'blank' });
  });

  it('★★ the route’s 500 for exhausted units is told apart by its `ai_units:` message', async () => {
    post.mockRejectedValue(
      new ApiError({
        kind: 'server',
        status: 500,
        developerMessage: 'ai_units:units_exhausted',
        method: 'POST',
        route: '/api/ai-assist/compose',
      } as never),
    );
    expect(await composeDraft('c1', 'rewrite', 'draft')).toEqual({
      ok: false,
      reason: 'units_exhausted',
    });
  });

  it('⚠ and any other 500 is still a plain failure', async () => {
    post.mockRejectedValue(
      new ApiError({
        kind: 'server',
        status: 500,
        developerMessage: 'Failed to compose message',
        method: 'POST',
        route: '/x',
      } as never),
    );
    expect(await composeDraft('c1', 'rewrite', 'draft')).toEqual({ ok: false, reason: 'failed' });
  });

  it('a failure is a failure', async () => {
    post.mockRejectedValue(new Error('boom'));
    expect(await composeDraft('c1', 'rewrite', 'draft')).toEqual({ ok: false, reason: 'failed' });
  });
});
