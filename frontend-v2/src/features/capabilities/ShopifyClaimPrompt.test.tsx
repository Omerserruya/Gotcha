import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingInstall } from '@/api/contracts/shopify-install';
import billingMessages from '@/i18n/messages/en/billing.json';
import messages from '@/i18n/messages/en/capabilities.json';
import heMessages from '@/i18n/messages/he/capabilities.json';

/**
 * The claim prompt drawn on every app page (App Review 132211, 2.1.1).
 * The actions are mocked: nothing here claims, dismisses or starts anything.
 */
const claimShopifyInstall = vi.hoisted(() => vi.fn());
const dismissShopifyPending = vi.hoisted(() => vi.fn());
const startShopifyInstall = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const support = vi.hoisted(() => ({ active: false }));
vi.mock('./shopify-actions', () => ({
  claimShopifyInstall,
  dismissShopifyPending,
  startShopifyInstall,
  verifyShopifyBilling: vi.fn(),
}));
vi.mock('@/support/support-context', () => ({
  useSupport: () => ({ active: support.active, session: null, refuses: () => support.active }),
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ShopifyClaimPrompt } from './ShopifyClaimPrompt';

const pending = (over: Partial<PendingInstall> = {}): PendingInstall => ({
  shopDomain: 'new.myshopify.com',
  expiresAt: null,
  current: null,
  action: 'attach',
  blockedReason: null,
  ...over,
});

const draw = (p: PendingInstall, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ capabilities: locale === 'he' ? heMessages : messages, billing: billingMessages }}
    >
      <ShopifyClaimPrompt pending={p} />
    </NextIntlClientProvider>,
  );

const assign = vi.fn();
beforeEach(() => {
  claimShopifyInstall.mockReset();
  dismissShopifyPending.mockReset();
  dismissShopifyPending.mockResolvedValue(undefined);
  startShopifyInstall.mockReset();
  push.mockReset();
  assign.mockReset();
  support.active = false;
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('★★ attach - asked, then claimed', () => {
  it('nothing is claimed before the press; then claim(false), and to the store’s page', async () => {
    claimShopifyInstall.mockResolvedValue({ ok: true, planSelectionUrl: null });
    draw(pending());
    expect(screen.getByTestId('shopify-claim-lead')).toHaveTextContent(
      'You approved new.myshopify.com in Shopify. Connect it to this workspace?',
    );
    expect(claimShopifyInstall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    expect(claimShopifyInstall).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('shopify-claimed')).toHaveTextContent(
      'new.myshopify.com is connected.',
    );
    expect(push).toHaveBeenCalledWith('/studio/capabilities?system=shopify');
  });

  it('a plan owed: straight to Shopify’s hosted pricing page', async () => {
    claimShopifyInstall.mockResolvedValue({
      ok: true,
      planSelectionUrl: 'https://admin.shopify.com/charges/x',
    });
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    expect(assign).toHaveBeenCalledWith('https://admin.shopify.com/charges/x');
    expect(push).not.toHaveBeenCalled();
  });

  it('final contract: a DISCONNECTED store here is named as the one it replaces', () => {
    draw(pending({ current: { shopDomain: 'old.myshopify.com', status: 'DISCONNECTED' } }));
    expect(screen.getByTestId('shopify-claim-lead')).toHaveTextContent(
      'Connect it to this workspace? (It replaces the uninstalled old.myshopify.com.)',
    );
  });

  it('Not now: dismissed, the prompt goes, nothing claimed', async () => {
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-not-now'));
    expect(dismissShopifyPending).toHaveBeenCalledTimes(1);
    expect(claimShopifyInstall).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shopify-claim-prompt')).toBeNull();
  });

  it('support mode: not drawn - connecting a store is the merchant’s own', () => {
    support.active = true;
    draw(pending());
    expect(screen.queryByTestId('shopify-claim-prompt')).toBeNull();
  });
});

describe('★★ replace - Omer’s question, in a dialog', () => {
  it('action replace: the dialog names both stores; Replace claims with replace: true', async () => {
    claimShopifyInstall.mockResolvedValue({ ok: true, planSelectionUrl: null });
    draw(
      pending({
        action: 'replace',
        current: { shopDomain: 'old.myshopify.com', status: 'CONNECTED' },
      }),
    );
    expect(screen.queryByTestId('shopify-replace-dialog')).toBeNull();
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    expect(claimShopifyInstall).not.toHaveBeenCalled();
    expect(screen.getByTestId('shopify-replace-dialog')).toHaveTextContent(
      'This workspace supports one Shopify store. Replace old.myshopify.com with new.myshopify.com?',
    );
    await userEvent.click(screen.getByTestId('shopify-replace-go'));
    expect(claimShopifyInstall).toHaveBeenCalledWith(true);
  });

  it('★★ Cancel dismisses and touches no store', async () => {
    draw(
      pending({
        action: 'replace',
        current: { shopDomain: 'old.myshopify.com', status: 'CONNECTED' },
      }),
    );
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    await userEvent.click(screen.getByTestId('shopify-replace-cancel'));
    expect(dismissShopifyPending).toHaveBeenCalledTimes(1);
    expect(claimShopifyInstall).not.toHaveBeenCalled();
  });

  it('attach answered 409 replace_required: the same question, naming the store the server named', async () => {
    claimShopifyInstall.mockResolvedValueOnce({
      ok: false,
      reason: 'replace_required',
      currentShop: 'old.myshopify.com',
    });
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    expect(screen.getByTestId('shopify-replace-dialog')).toHaveTextContent(
      'Replace old.myshopify.com with new.myshopify.com?',
    );
    expect(screen.queryByTestId('shopify-claim-problem')).toBeNull();
    claimShopifyInstall.mockResolvedValueOnce({ ok: true, planSelectionUrl: null });
    await userEvent.click(screen.getByTestId('shopify-replace-go'));
    expect(claimShopifyInstall).toHaveBeenLastCalledWith(true);
  });

  it('Hebrew: the question with a non-breaking hyphen after ב, and החלפה / ביטול', async () => {
    draw(
      pending({
        action: 'replace',
        current: { shopDomain: 'old.myshopify.com', status: 'CONNECTED' },
      }),
      'he',
    );
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    expect(screen.getByTestId('shopify-replace-dialog')).toHaveTextContent(
      'הארגון הזה תומך בחנות Shopify אחת. להחליף את old.myshopify.com ב‑new.myshopify.com?',
    );
    expect(screen.getByTestId('shopify-replace-go')).toHaveTextContent('החלפה');
    expect(screen.getByTestId('shopify-replace-cancel')).toHaveTextContent('ביטול');
  });
});

describe('★★ every refusal is its own sentence, with a way on', () => {
  it.each([
    ['core_plan_required', 'needs an active GOTCHA Core plan first', 'shopify-claim-plan'],
    [
      'held_by_other_workspace',
      'is connected to another GOTCHA workspace. Disconnect it there first.',
      'shopify-claim-dismiss',
    ],
    ['expired', 'has expired. Connect again to start over.', 'shopify-claim-start'],
    ['billing_unavailable', 'Nothing changed. Try again.', 'shopify-claim-retry'],
    ['failed', 'new.myshopify.com wasn’t connected. Try again.', 'shopify-claim-retry'],
  ] as const)('%s: said, and %s offered', async (reason, line, control) => {
    claimShopifyInstall.mockResolvedValueOnce({ ok: false, reason });
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    const problem = screen.getByTestId('shopify-claim-problem');
    expect(problem).toHaveAttribute('data-reason', reason);
    expect(problem).toHaveTextContent(line);
    expect(screen.getByTestId(control)).toBeInTheDocument();
  });

  it('five refusals, five different sentences', async () => {
    const lines = new Set<string>();
    for (const reason of [
      'core_plan_required',
      'held_by_other_workspace',
      'expired',
      'billing_unavailable',
      'failed',
    ]) {
      claimShopifyInstall.mockResolvedValueOnce({ ok: false, reason });
      const { unmount } = draw(pending());
      await userEvent.click(screen.getByTestId('shopify-claim-go'));
      lines.add(screen.getByTestId('shopify-claim-problem').textContent ?? '');
      unmount();
    }
    expect(lines.size).toBe(5);
  });

  it('expired: Connect again is a real start, to Shopify’s page', async () => {
    claimShopifyInstall.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    startShopifyInstall.mockResolvedValue({ ok: true, url: 'https://admin.shopify.com/oauth/x' });
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    await userEvent.click(screen.getByTestId('shopify-claim-start'));
    expect(assign).toHaveBeenCalledWith('https://admin.shopify.com/oauth/x');
  });

  it('billing unavailable: Try again claims again with the same approval', async () => {
    claimShopifyInstall.mockResolvedValueOnce({ ok: false, reason: 'billing_unavailable' });
    draw(pending());
    await userEvent.click(screen.getByTestId('shopify-claim-go'));
    claimShopifyInstall.mockResolvedValueOnce({ ok: true, planSelectionUrl: null });
    await userEvent.click(screen.getByTestId('shopify-claim-retry'));
    expect(claimShopifyInstall).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('shopify-claimed')).toBeInTheDocument();
  });

  it.each([
    ['core_plan_required', 'needs an active GOTCHA Core plan first'],
    [
      'held_by_other_workspace',
      'is connected to another GOTCHA workspace. Disconnect it there first.',
    ],
  ] as const)(
    'blocked before any press (%s): said at once, nothing claimed',
    (blockedReason, line) => {
      draw(pending({ action: 'blocked', blockedReason }));
      expect(screen.getByTestId('shopify-claim-problem')).toHaveTextContent(line);
      expect(screen.queryByTestId('shopify-claim-go')).toBeNull();
      expect(claimShopifyInstall).not.toHaveBeenCalled();
    },
  );
});

describe('★★ the prompt is on the pages, not only in this file', () => {
  it('the app layout loads the pending install and draws the prompt; so does onboarding’s systems step', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8');
    const layout = src('app/[locale]/(app)/layout.tsx');
    expect(layout).toMatch(/await loadShopifyClaim\(\)/);
    expect(layout).toMatch(/<ShopifyClaimPrompt pending=\{shopifyClaim\} \/>/);
    expect(src('app/[locale]/(onboarding)/onboarding/systems/page.tsx')).toMatch(
      /loadShopifyClaim\(\)/,
    );
    expect(src('features/onboarding/SystemsStep.tsx')).toMatch(
      /<ShopifyClaimPrompt pending=\{shopifyClaim\} \/>/,
    );
  });
});
