/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** ★★ Who is asking: the browser's address, sent upstream only by this server (prod, 2026-11-16). */
const warn = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { clientForwarding, resetClientForwardingWarning } = await import('./client-forwarding');

const ON = { API_FORWARD_CLIENT: 'on' as const, APP_ORIGIN: 'https://app.gotcha.co.il' };
const from = (entries: Record<string, string>) => new Headers(entries);

beforeEach(() => {
  warn.mockReset();
  resetClientForwardingWarning();
});

describe('★★ clientForwarding', () => {
  it('★★ sends the address the gateway computed (X-Real-IP), as CF-Connecting-IP', () => {
    expect(clientForwarding(from({ 'x-real-ip': '203.0.113.9' }), ON)).toEqual({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-host': 'app.gotcha.co.il',
      'x-forwarded-proto': 'https',
    });
    expect(clientForwarding(from({ 'x-real-ip': '2001:db8::7' }), ON)['cf-connecting-ip']).toBe('2001:db8::7');
  });

  it('★★ never the browser’s own CF-Connecting-IP or X-Forwarded-For', () => {
    const sent = clientForwarding(
      from({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2', 'x-real-ip': '203.0.113.9' }),
      ON,
    );
    expect(sent['cf-connecting-ip']).toBe('203.0.113.9');
    expect(clientForwarding(from({ 'cf-connecting-ip': '198.51.100.1' }), ON)['cf-connecting-ip']).toBeUndefined();
  });

  it('★★ no address, or not an address: no header (never a guess), and one warning per process', () => {
    expect(clientForwarding(from({}), ON)['cf-connecting-ip']).toBeUndefined();
    expect(clientForwarding(from({ 'x-real-ip': 'evil, 1.2.3.4' }), ON)['cf-connecting-ip']).toBeUndefined();
    expect(clientForwarding(null, ON)['cf-connecting-ip']).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('api.client_address_missing', { present: false });
  });

  it('★★ off unless exactly "on": nothing at all is sent', () => {
    const real = from({ 'x-real-ip': '203.0.113.9' });
    for (const value of ['off', '', 'true', undefined]) {
      expect(clientForwarding(real, { ...ON, API_FORWARD_CLIENT: value as 'off' })).toEqual({});
    }
  });
});
