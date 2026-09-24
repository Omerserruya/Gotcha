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
vi.mock('./actions', () => ({ electRole }));

beforeEach(() => {
  // Reset, not just clear: a mock left resolving the previous test's value is
  // how a green suite ends up asserting nothing at all.
  electRole.mockReset();
  electRole.mockResolvedValue({ ok: true, data: { replaced: null } });
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

describe('what is offered', () => {
  it('offers the connected systems and NOT the broken one', () => {
    /*
     * ★ THE ASSERTION THIS CONTROL EXISTS AROUND.
     *
     * The write refuses a system that is not CONNECTED. Backend found this
     * live in the other direction: the READ reported Shopify as connected
     * because a row existed, while the write refused it. A broken system in
     * this list is a choice the server rejects on save, and the merchant
     * reads the rejection as the screen failing rather than as their shop
     * being down.
     */
    show(part());
    expect(screen.getByRole('option', { name: 'Shopify' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'WooCommerce' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'BigCommerce' })).toBeNull();
  });

  it('starts on an explicit “not chosen”, never on the first system', () => {
    /*
     * A select with no empty option shows its first child as though it had
     * been picked. That is the calm wrong value — not an error, not a blank,
     * just somebody else's decision wearing the merchant's — and it would
     * read as "Shopify does this" on a part nobody has decided.
     */
    show(part());
    const select = screen.getByTestId('core-elect-select-ecommerce') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: /not chosen/i })).toBeInTheDocument();
  });

  it('renders nothing when no candidate is connected', () => {
    // The part's own three-state sentence already says which case it is and
    // where the repair lives. An empty dropdown beside it would imply the
    // answer is one selection away.
    const { container } = show(
      part({
        candidates: [{ slug: 'broken', name: 'BigCommerce', connected: false, status: 'ERROR' }],
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says where connecting happens instead of offering a dead link', () => {
    /*
     * There is no marketplace route in this app and no configured URL for
     * the platform's — `NEXT_PUBLIC_*` carries the realtime host and nothing
     * else. An anchor here would 404 at the exact moment somebody is trying
     * to give the product more to work with.
     */
    show(part());
    const connect = screen.getByTestId('core-elect-connect');
    expect(connect.tagName).not.toBe('A');
    expect(connect).toHaveTextContent(/marketplace/i);
    expect(connect).toHaveTextContent(/not on this screen/i);
  });
});

describe('saving', () => {
  it('will not save until something different is chosen', async () => {
    const user = userEvent.setup();
    show(part({ elected: { slug: 'shopify', name: 'Shopify' } }));

    // Already elected: there is nothing to write.
    expect(screen.getByTestId('core-elect-save-ecommerce')).toBeDisabled();

    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'woo');
    expect(screen.getByTestId('core-elect-save-ecommerce')).toBeEnabled();
  });

  it('★ names what the save DISPLACED', async () => {
    /*
     * The write displaces rather than refusing when a part is taken, because
     * refusing recreates the undeletable-employee trap — somebody blocked by
     * a state they cannot see and did not set.
     *
     * But silent displacement is the reassuring direction. "Saved." alone
     * would hide that WooCommerce just stopped doing this job, which is the
     * more consequential half of what happened.
     */
    electRole.mockResolvedValue({
      ok: true,
      data: { replaced: { slug: 'woo', name: 'WooCommerce' } },
    });
    const user = userEvent.setup();
    show(part());

    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    expect(electRole).toHaveBeenCalledWith('ecommerce', 'shopify');
    expect(await screen.findByTestId('core-elect-ok-ecommerce')).toHaveTextContent(
      /it was WooCommerce before/i,
    );
  });

  it('does not invent a displacement when there was none', async () => {
    const user = userEvent.setup();
    show(part());
    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    const ok = await screen.findByTestId('core-elect-ok-ecommerce');
    expect(ok).toHaveTextContent(/saved/i);
    expect(ok).not.toHaveTextContent(/before/i);
  });
});

describe('the three failures are three sentences', () => {
  it('a system that stopped being connected sends them to the marketplace', async () => {
    /*
     * Not a bug and not a generic failure. The read offers a candidate from a
     * TenantIntegration row; the write requires status CONNECTED. A system
     * can be offered and refused in the same breath if it breaks while the
     * page is open, and the merchant can see and fix that.
     */
    electRole.mockResolvedValue({ ok: false, reason: 'not_connected' });
    const user = userEvent.setup();
    show(part());
    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    expect(await screen.findByTestId('core-elect-error-ecommerce')).toHaveTextContent(
      /stopped being connected while this page was open/i,
    );
  });

  it('★ the CRM refusal points at the other screen, not at a reconnection', async () => {
    /*
     * A 409 here means two entirely different things. A single "couldn't save
     * that" — or worse, the not-connected sentence — would send somebody to
     * reconnect a system that is working perfectly.
     */
    electRole.mockResolvedValue({ ok: false, reason: 'crm_elsewhere' });
    const user = userEvent.setup();
    show(part({ role: 'ecommerce' }));
    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    const error = await screen.findByTestId('core-elect-error-ecommerce');
    // The real `crm.elsewhere` copy, which names the one place and says why
    // there is only one: so this screen can never disagree with the system
    // the AI actually calls.
    expect(error).toHaveTextContent(/chosen on the Integrations screen, not here/i);
    expect(error).toHaveTextContent(/one place for it/i);
    expect(error).not.toHaveTextContent(/stopped being connected/i);
  });

  it('★ the returns refusal points at its OWN switch, not at the CRM screen', async () => {
    /*
     * The second refusal, added when Backend landed `RETURNS_ELECTED_ELSEWHERE`.
     * `config.returnProvider` is a different switch on a different screen
     * from `config.useAsCrm`, so reusing the CRM sentence here would send
     * somebody to the wrong place with a sentence that sounds right —
     * which is worse than a generic failure, because they would act on it.
     */
    electRole.mockResolvedValue({ ok: false, reason: 'returns_elsewhere' });
    const user = userEvent.setup();
    show(part());
    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    const error = await screen.findByTestId('core-elect-error-ecommerce');
    expect(error).toHaveTextContent(/own switch/i);
    // And explicitly NOT the CRM's destination.
    expect(error).not.toHaveTextContent(/Integrations screen/i);
    expect(error).not.toHaveTextContent(/Customer records/i);
  });

  it('a generic failure says nothing was changed', async () => {
    // The one thing somebody needs after a failed write is whether it half
    // happened.
    electRole.mockResolvedValue({ ok: false, reason: 'failed' });
    const user = userEvent.setup();
    show(part());
    await user.selectOptions(screen.getByTestId('core-elect-select-ecommerce'), 'shopify');
    await user.click(screen.getByTestId('core-elect-save-ecommerce'));

    expect(await screen.findByTestId('core-elect-error-ecommerce')).toHaveTextContent(
      /nothing was changed/i,
    );
  });
});
