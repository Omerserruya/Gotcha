import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/capabilities.json';
import he from '@/i18n/messages/he/capabilities.json';

const probeWooStore = vi.hoisted(() => vi.fn());
vi.mock('./woo-probe-actions', () => ({ probeWooStore }));

import { WooFirewallHelp } from './WooFirewallHelp';

/** The store's firewall stopped GOTCHA (store_firewall_challenge, 2026-11-15). */
const blocked = (over: Record<string, unknown>) => ({
  ok: true,
  probe: {
    reachable: false,
    reason: 'store_firewall_challenge',
    storeUrl: 'https://alphamom.co.il',
    checkedAt: '2026-11-15T14:00:00Z',
    egress: null,
    ...over,
  },
});

const show = async (locale: 'en' | 'he' = 'en') => {
  render(
    <NextIntlClientProvider locale={locale} messages={{ capabilities: locale === 'he' ? he : en }}>
      <WooFirewallHelp />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('woo-firewall-checking')).toBeNull());
};

beforeEach(() => {
  probeWooStore.mockReset();
});

describe('★★ what the probe found decides the steps', () => {
  it("★★ Cloudflare, stable address: the IP rule first, with GOTCHA's address; the path rule after", async () => {
    probeWooStore.mockResolvedValue(
      blocked({ firewall: 'cloudflare', egress: { ips: ['51.84.227.95'], stable: true } }),
    );
    await show();
    const rules = screen.getAllByTestId(/woo-firewall-rule-/).map((el) => el.dataset.testid);
    expect(rules).toEqual(['woo-firewall-rule-ip', 'woo-firewall-rule-path']);
    expect(screen.getByTestId('woo-firewall-rule-ip')).toHaveTextContent('IP Source Address');
    expect(screen.getByTestId('woo-firewall-rule-ip')).toHaveTextContent('51.84.227.95');
    expect(screen.getByTestId('woo-firewall-rule-path')).toHaveTextContent('/wp-json/wc/');
    // Cloudflare's new dashboard first, the older path beside it (Supervisior, from Cloudflare's docs).
    expect(screen.getByTestId('woo-firewall-rule-ip')).toHaveTextContent(
      'Security › Security rules',
    );
    expect(screen.getByTestId('woo-firewall-rule-ip')).toHaveTextContent(
      'Security › WAF › Custom rules',
    );
    expect(screen.getByTestId('woo-firewall-rule-ip')).toHaveTextContent('Security › Bots');
    expect(screen.queryByTestId('woo-firewall-may-change')).toBeNull();
    expect(screen.getByText(/the store's firewall \(Cloudflare\)/)).toBeInTheDocument();
  });

  it('★★ an address that may change: the path rule first, the IP rule flagged', async () => {
    probeWooStore.mockResolvedValue(
      blocked({ firewall: 'cloudflare', egress: { ips: ['89.138.9.205'], stable: false } }),
    );
    await show();
    expect(screen.getAllByTestId(/woo-firewall-rule-/).map((el) => el.dataset.testid)).toEqual([
      'woo-firewall-rule-path',
      'woo-firewall-rule-ip',
    ]);
    expect(screen.getByTestId('woo-firewall-may-change')).toBeInTheDocument();
  });

  it('★★ Cloudflare, no address: the path rule only - never an empty or guessed IP', async () => {
    probeWooStore.mockResolvedValue(blocked({ firewall: 'cloudflare', egress: null }));
    await show();
    expect(screen.getAllByTestId(/woo-firewall-rule-/).map((el) => el.dataset.testid)).toEqual([
      'woo-firewall-rule-path',
    ]);
    expect(screen.queryByText(/IP Source Address/)).toBeNull();
  });

  it('★★ Sucuri: the host and the plugin, named - no Cloudflare step at all', async () => {
    probeWooStore.mockResolvedValue(
      blocked({ firewall: 'sucuri', egress: { ips: ['51.84.227.95'], stable: true } }),
    );
    await show();
    expect(screen.getByTestId('woo-firewall-host')).toHaveTextContent('(Sucuri)');
    expect(screen.queryByText(/dash\.cloudflare\.com/)).toBeNull();
    expect(screen.queryByTestId(/woo-firewall-rule-/)).toBeNull();
  });

  it('★ the probe failed: the host paragraph, unnamed', async () => {
    probeWooStore.mockResolvedValue({ ok: false, reason: 'failed' });
    await show();
    expect(screen.getByTestId('woo-firewall-host')).not.toHaveTextContent('(');
    expect(screen.queryByText(/dash\.cloudflare\.com/)).toBeNull();
  });

  it("★ Hebrew: Cloudflare's controls as Cloudflare writes them, left to right", async () => {
    probeWooStore.mockResolvedValue(
      blocked({ firewall: 'cloudflare', egress: { ips: ['51.84.227.95'], stable: true } }),
    );
    await show('he');
    const label = screen.getAllByText('IP Source Address')[0]!;
    expect(label.tagName).toBe('BDI');
    expect(label).toHaveAttribute('dir', 'ltr');
  });
});

describe('★ Check now, and the steps for a developer', () => {
  it('★★ Check now says what it found', async () => {
    probeWooStore.mockResolvedValue(blocked({ firewall: 'cloudflare' }));
    await show();
    probeWooStore.mockResolvedValue({ ok: true, probe: { reachable: true, reason: 'reachable' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('woo-firewall-check'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('woo-firewall-result')).toHaveAttribute('data-result', 'open'),
    );
  });

  it("★★ the copy is the rule itself: the address, the path, Cloudflare's words", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    probeWooStore.mockResolvedValue(
      blocked({ firewall: 'cloudflare', egress: { ips: ['51.84.227.95'], stable: true } }),
    );
    await show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('woo-firewall-copy'));
    });
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain('"IP Source Address"');
    expect(text).toContain('"51.84.227.95"');
    expect(text).toContain('"/wp-json/wc/"');
    expect(text).toMatch(/^1\. /m);
    expect(text).not.toMatch(/<ui>|\[object/);
  });

  it("★ the way to connect again is the screen's own, said when there is no slot", async () => {
    probeWooStore.mockResolvedValue(blocked({ firewall: 'cloudflare' }));
    await show();
    expect(screen.getByTestId('woo-firewall-then')).toHaveTextContent(en.wooFirewall.thenConnect);
  });
});

describe('★★ the store already answers: no steps, only "connect again"', () => {
  it('★★ a reachable store gets the way on, never "ask your host"', async () => {
    probeWooStore.mockResolvedValue({
      ok: true,
      probe: { reachable: true, reason: 'reachable', egress: null },
    });
    await show();
    expect(screen.getByTestId('woo-firewall-result')).toHaveAttribute('data-result', 'open');
    expect(screen.queryByTestId('woo-firewall-host')).toBeNull();
    expect(screen.queryByTestId(/woo-firewall-rule-/)).toBeNull();
  });
});
