import { describe, expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
const cookieJar = vi.hoisted(() => ({ has: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => cookieJar }));
vi.mock('./read-terms', () => ({ readTermsRequired: read }));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({ auth: {} }) }));
const TermsGate = vi.hoisted(() => vi.fn(() => null));
vi.mock('./TermsGate', () => ({ TermsGate }));

const { termsGateScreen } = await import('./terms-gate-screen');

function holds(type: unknown, node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return true;
  return Object.values(el.props ?? {}).some((value) =>
    Array.isArray(value) ? value.some((v) => holds(type, v)) : holds(type, value),
  );
}

describe('★★ termsGateScreen: asked only while the sign-in owes the Terms', () => {
  it('★★ no marker: nothing, and NO read - a password sign-in never pays for this', async () => {
    cookieJar.has.mockReturnValue(false);
    read.mockReset();
    expect(await termsGateScreen('he')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('★★ marker and owed: the gate', async () => {
    cookieJar.has.mockReturnValue(true);
    read.mockResolvedValue(true);
    expect(holds(TermsGate, await termsGateScreen('he'))).toBe(true);
  });

  it('⚠⚠ marker and unread (a 503): the gate - the answer held is "owed", never false', async () => {
    cookieJar.has.mockReturnValue(true);
    read.mockResolvedValue(null);
    expect(holds(TermsGate, await termsGateScreen('en'))).toBe(true);
  });

  it('★ marker but accepted elsewhere, or a support session (the route answers false): the area', async () => {
    cookieJar.has.mockReturnValue(true);
    read.mockResolvedValue(false);
    expect(await termsGateScreen('en')).toBeNull();
  });

  it('★ the marker is read by its name', async () => {
    cookieJar.has.mockReturnValue(false);
    await termsGateScreen('en');
    expect(cookieJar.has).toHaveBeenCalledWith('gotcha_terms_pending');
  });
});
