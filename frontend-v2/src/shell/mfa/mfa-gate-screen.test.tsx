import { describe, expect, it, vi } from 'vitest';

/** ★★ The one rule every signed-in door uses: owed, the gate; else, or unread, nothing. */
const read = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('./read-mfa-gate', () => ({
  readMfaGate: read,
  authOrigin: () => 'https://auth.example.test',
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({ security: {} }) }));
const MfaGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('./MfaGate', () => ({ MfaGate }));

const { mfaGateScreen } = await import('./mfa-gate-screen');

/** One component's props, wherever it sits in the tree. */
function propsOf(type: unknown, node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? null;
  for (const value of Object.values(el.props ?? {})) {
    const hit = Array.isArray(value)
      ? value.map((v) => propsOf(type, v)).find(Boolean)
      : propsOf(type, value);
    if (hit) return hit;
  }
  return null;
}

describe('★★ mfaGateScreen', () => {
  it('owed: the gate, with the server’s answer and the provider’s origin', async () => {
    read.mockResolvedValue({ mustEnroll: true, reason: 'all_users' });
    expect(propsOf(MfaGate, await mfaGateScreen('he'))).toMatchObject({
      initial: { mustEnroll: true, reason: 'all_users' },
      authOrigin: 'https://auth.example.test',
    });
  });

  it.each([[{ mustEnroll: false }], [null]])('not owed, or unread (%#): nothing', async (gate) => {
    read.mockResolvedValue(gate);
    expect(await mfaGateScreen('en')).toBeNull();
  });
});
