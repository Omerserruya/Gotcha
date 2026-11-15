import { describe, expect, it } from 'vitest';

import { storeProbeSchema } from '@/api/contracts/woo-probe';

import { firewallPlan, ipCondition, probeState } from './woo-firewall';

/** store_firewall_challenge (Backend 7816b537, fb28bd20, e538c635): what the probe says, read. */
const probe = (over: Record<string, unknown>) =>
  storeProbeSchema.parse({
    reachable: false,
    reason: 'store_firewall_challenge',
    storeUrl: 'https://alphamom.co.il',
    checkedAt: '2026-11-15T14:00:00Z',
    ...over,
  });

describe("★★ the probe's address: only what is an IP, and never a guess", () => {
  it('★★ an address that is not an IP is dropped, never printed', () => {
    expect(
      probe({
        egress: {
          ips: ['51.84.227.95', 'evil.example', '1.2.3.999', ' 51.84.227.95 '],
          stable: true,
        },
      }).egress,
    ).toEqual({
      ips: ['51.84.227.95'],
      stable: true,
    });
  });

  it('★ IPv6 is an address', () => {
    expect(probe({ egress: { ips: ['2001:db8::1'], stable: false } }).egress?.ips).toEqual([
      '2001:db8::1',
    ]);
  });

  it.each([
    [null],
    [undefined],
    [{ ips: [], stable: true }],
    [{ ips: ['nope'], stable: true }],
    ['x'],
    [{ stable: true }],
  ])('★★ %j is no address: the path rule only', (egress) => {
    expect(probe({ firewall: 'cloudflare', egress }).egress).toBeNull();
  });

  it('★ an unknown firewall is "other", never a failed read', () => {
    expect(probe({ firewall: 'akamai' }).firewall).toBe('other');
  });
});

describe("★★ firewallPlan: Cloudflare's steps only for Cloudflare, in the order the address allows", () => {
  const egress = (stable: boolean) => ({ ips: ['51.84.227.95'], stable });

  it('★★ a stable address: the IP rule first (Omer), the path rule as the alternative', () => {
    expect(firewallPlan(probe({ firewall: 'cloudflare', egress: egress(true) }))).toMatchObject({
      kind: 'cloudflare',
      rules: ['ip', 'path'],
    });
  });

  it('★★ an address that may still change: the path rule first - it survives the change', () => {
    expect(firewallPlan(probe({ firewall: 'cloudflare', egress: egress(false) }))).toMatchObject({
      kind: 'cloudflare',
      rules: ['path', 'ip'],
    });
  });

  it('★★ Cloudflare with no address: the path rule only', () => {
    expect(firewallPlan(probe({ firewall: 'cloudflare', egress: null }))).toEqual({
      kind: 'cloudflare',
      rules: ['path'],
      egress: null,
    });
  });

  it.each([
    ['sucuri', 'sucuri'],
    ['imunify360', 'imunify360'],
    ['other', null],
  ] as const)("★★ %s: the host or the plugin, never Cloudflare's steps", (firewall, named) => {
    expect(firewallPlan(probe({ firewall, egress: egress(true) }))).toEqual({
      kind: 'host',
      firewall: named,
    });
  });

  it('★ the probe could not tell: the host, unnamed', () => {
    expect(firewallPlan(null)).toEqual({ kind: 'host', firewall: null });
  });
});

describe('★ the pieces', () => {
  it('one address equals; several are in a set', () => {
    expect(ipCondition(['51.84.227.95'])).toEqual({ operator: 'equals', value: '51.84.227.95' });
    expect(ipCondition(['1.1.1.1', '2.2.2.2'])).toEqual({
      operator: 'is in',
      value: '{1.1.1.1 2.2.2.2}',
    });
  });

  it('what "Check now" found', () => {
    expect(probeState(probe({ reachable: true, reason: 'reachable' }))).toBe('open');
    expect(probeState(probe({}))).toBe('blocked');
    expect(probeState(probe({ reason: 'timeout' }))).toBe('unknown');
    expect(probeState(null)).toBe('unknown');
  });
});
