import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rolePartSchema, type RolePart } from '@/api/contracts/business-core';
import messages from '@/i18n/messages/en/business-core.json';

import { ElectPart } from './ElectPart';

/**
 * Screen 14c's election control.
 *
 * ── EVERY BRANCH HERE IS UNREACHABLE BY A CAPTURE ──
 * `electable()` requires a CONNECTED candidate. The only integration on this
 * deployment is Shopify and it is in ERROR, so the control renders for no
 * part on the live tenant and no screenshot can contain it. The success path,
 * the displacement sentence and all three failures are assertable only here.
 *
 * ── AND NOTHING IN THIS FILE PERFORMS A WRITE ──
 * `electRole` is mocked. The real one writes `config.roles` on a live tenant
 * and DISPLACES whatever held the part; a test that called it would silently
 * rewrite the estate these screens are photographed against.
 */

const electRole = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ electRole }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  // Reset, not just clear: a mock left resolving the previous test's value is
  // how a green suite ends up asserting nothing at all.
  electRole.mockReset();
  electRole.mockResolvedValue({ ok: true, data: { replaced: null } });
  refresh.mockReset();
});

function part(over: Record<string, unknown> = {}): RolePart {
  return rolePartSchema.parse({
    role: 'ecommerce',
    candidates: [
      { slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' },
      { slug: 'woo', name: 'WooCommerce', connected: true, status: 'CONNECTED' },
      { slug: 'broken', name: 'BigCommerce', connected: false, status: 'ERROR' },
    ],
    ...over,
  });
}

const show = (p: RolePart) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ 'business-core': messages }}>
      <ElectPart part={p} />
    </NextIntlClientProvider>,
  );

const open = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByTestId('core-elect-open-ecommerce'));
const choose = async (user: ReturnType<typeof userEvent.setup>, slug: string) => {
  await open(user);
  await user.click(screen.getByTestId(`core-elect-option-ecommerce-${slug}`));
};

describe('what is offered — 02’s pill, "the dropdown, never a connect form"', () => {
  it('★ offers the connected systems, each with its mark; the broken one disabled, with why', async () => {
    /*
     * The write refuses a system that is not CONNECTED. A broken system in
     * this list is a choice the server rejects on save, and the merchant
     * reads the rejection as the screen failing rather than as their shop
     * being down.
     */
    const user = userEvent.setup();
    show(part());
    await open(user);
    expect(screen.getByRole('option', { name: 'Shopify' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'WooCommerce' })).toBeInTheDocument();
    // Listed, never choosable: the write would refuse it, and why is said beside it.
    const broken = screen.getByTestId('core-elect-option-ecommerce-broken');
    expect(broken).toBeDisabled();
    expect(broken).toHaveTextContent('Not working — fix it in Integrations first');
    expect(screen.getByTestId('core-elect-menu-ecommerce')).toHaveTextContent(
      'Connected in Integrations',
    );
    expect(
      screen.getByTestId('core-elect-option-ecommerce-shopify').querySelector('[data-logo]'),
    ).toHaveAttribute('data-logo', 'shopify');
  });

  it('nothing chosen reads "Not chosen" — never the first system', async () => {
    // The calm wrong value: somebody else's decision wearing the merchant's.
    show(part());
    expect(screen.getByTestId('core-elect-open-ecommerce')).toHaveTextContent('Not chosen');
  });

  it('the chosen one is named on the pill, and marked in the menu', async () => {
    const user = userEvent.setup();
    show(part({ elected: { slug: 'woo', name: 'WooCommerce' } }));
    expect(screen.getByTestId('core-elect-open-ecommerce')).toHaveTextContent('WooCommerce');
    await open(user);
    expect(screen.getByRole('option', { name: 'WooCommerce' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders nothing when no candidate is connected', () => {
    const { container } = show(
      part({
        candidates: [{ slug: 'broken', name: 'BigCommerce', connected: false, status: 'ERROR' }],
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says where connecting happens — at the foot of the menu, never a dead link', async () => {
    const user = userEvent.setup();
    show(part());
    await open(user);
    const connect = screen.getByTestId('core-elect-connect');
    expect(connect.tagName).not.toBe('A');
    expect(connect).toHaveTextContent(/marketplace/i);
  });

  it('★ no paragraph grows the row: closed, the pill is all there is', () => {
    show(part());
    expect(screen.queryByTestId('core-elect-connect')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('choosing saves', () => {
  it('choosing the one already chosen writes nothing', async () => {
    const user = userEvent.setup();
    show(part({ elected: { slug: 'shopify', name: 'Shopify' } }));
    await choose(user, 'shopify');
    expect(electRole).not.toHaveBeenCalled();
  });

  it('★ names what the save DISPLACED, and the page is re-read', async () => {
    electRole.mockResolvedValue({
      ok: true,
      data: { replaced: { slug: 'woo', name: 'WooCommerce' } },
    });
    const user = userEvent.setup();
    show(part());
    await choose(user, 'shopify');
    expect(electRole).toHaveBeenCalledWith('ecommerce', 'shopify');
    expect(screen.getByTestId('core-elect-said-ecommerce')).toHaveTextContent(
      /it was WooCommerce before/i,
    );
    expect(screen.getByTestId('core-elect-open-ecommerce')).toHaveAttribute(
      'title',
      expect.stringMatching(/it was WooCommerce before/i),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('does not invent a displacement when there was none', async () => {
    const user = userEvent.setup();
    show(part());
    await choose(user, 'shopify');
    const said = screen.getByTestId('core-elect-said-ecommerce');
    expect(said).toHaveTextContent(/saved/i);
    expect(said).not.toHaveTextContent(/before/i);
  });
});

describe('the three failures are three sentences', () => {
  it.each([
    ['not_connected', /stopped being connected while this page was open/i],
    ['crm_elsewhere', /chosen on the Integrations screen, not here/i],
    ['returns_elsewhere', /own switch/i],
  ] as const)('%s', async (reason, words) => {
    electRole.mockResolvedValue({ ok: false, reason });
    const user = userEvent.setup();
    show(part());
    await choose(user, 'shopify');
    expect(screen.getByTestId('core-elect-said-ecommerce')).toHaveTextContent(words);
    expect(screen.getByTestId('core-elect-open-ecommerce')).toHaveAttribute('data-problem');
    expect(refresh).not.toHaveBeenCalled();
  });
});
