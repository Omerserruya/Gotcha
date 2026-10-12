import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilitySchema, type Capability } from '@/api/contracts/capabilities';
import messages from '@/i18n/messages/en/capabilities.json';

import { setToolPermission } from './permission-actions';
import { PermissionChoice } from './PermissionChoice';

/**
 * Screen 10's three-state control.
 *
 * ⚠ NOTHING HERE PRESSES THE WRITE. The server action changes what the AI
 * may do to customers unattended; the behaviour under test is which choices
 * are OFFERED, which is decided before any request exists. The action is
 * mocked so that a future test cannot reach it by accident.
 */

vi.mock('./permission-actions', () => ({
  setToolPermission: vi.fn(async () => {
    throw new Error('a test must never call setToolPermission');
  }),
}));

const tool = (over: Record<string, unknown> = {}): Capability =>
  capabilitySchema.parse({
    toolName: 'shopify.get_order',
    riskGroup: 'read_only',
    enabled: true,
    requiresApproval: true,
    ...over,
  });

const show = (capability: Capability) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      <PermissionChoice capability={capability} />
    </NextIntlClientProvider>,
  );

/*
 * Superseded in form (S2, 2026-10-03): 02's control is ALWAYS three, the
 * stored one dark. "Do it" where it may not be chosen was absent; it is now
 * DISABLED, with its reason on itself. The rule is unchanged: it cannot be
 * chosen, and the screen says why.
 */
/*
 * And said on the row (Omer, 2026-10-12): the reason was a `title` on a
 * `disabled` button, a tooltip several browsers never show, so "Do it" was a
 * muted segment that did nothing. It is `aria-disabled` now - hoverable and
 * focusable, its tooltip shown - and the same sentence is a line under it.
 */
describe('★★ "Do it" is locked where it may not be chosen, and says why on the row', () => {
  it('★★ a tool that moves money: Do it locked, with the reason as tooltip and as a line', async () => {
    show(tool({ toolName: 'shopify.process_refund', riskGroup: 'financial' }));
    const doIt = screen.getByTestId('choice-shopify.process_refund-do_it');
    expect(doIt).toHaveAttribute('aria-disabled', 'true');
    // Not `disabled`: a disabled control shows no tooltip in several browsers.
    expect(doIt).not.toHaveAttribute('disabled');
    expect(doIt).toHaveAttribute(
      'title',
      expect.stringMatching(/deletes something, moves money or changes settings/i),
    );
    const line = screen.getByTestId('choice-why-shopify.process_refund');
    expect(line.textContent).toBe(doIt.getAttribute('title'));
    // Named by the line itself - `title` alone would give the same description.
    expect(doIt).toHaveAttribute('aria-describedby', line.id);
    expect(screen.getByTestId('choice-shopify.process_refund-ask_me')).toBeEnabled();
    expect(screen.getByTestId('choice-shopify.process_refund-never')).toBeEnabled();
  });

  it('★★ and on a row the read sent no group for - the OTHER sentence', async () => {
    // "We could not tell", not "this moves money": a reader can act on the
    // first and would be misled by the second.
    show(tool({ toolName: 'shopify.cancel_order', riskGroup: null }));
    expect(screen.getByTestId('choice-shopify.cancel_order-do_it')).toHaveAttribute(
      'title',
      expect.stringMatching(/can't tell what this one changes/i),
    );
    expect(screen.getByTestId('choice-why-shopify.cancel_order')).toHaveTextContent(
      /can't tell what this one changes/i,
    );
  });

  it('★★ pressing the locked one writes nothing and moves nothing', async () => {
    show(tool({ toolName: 'coupon', riskGroup: 'financial' }));
    await userEvent.click(screen.getByTestId('choice-coupon-do_it'));
    expect(setToolPermission).not.toHaveBeenCalled();
    expect(screen.getByTestId('choice-coupon-ask_me')).toHaveAttribute('data-current', 'yes');
    expect(screen.queryByTestId('choice-confirm-coupon')).toBeNull();
  });

  it('★ S2: create_update and sensitive_data may run on their own, as the server allows', () => {
    show(tool({ toolName: 'cu', riskGroup: 'create_update' }));
    show(tool({ toolName: 'sd', riskGroup: 'sensitive_data' }));
    for (const name of ['cu', 'sd']) {
      expect(screen.getByTestId(`choice-${name}-do_it`)).toBeEnabled();
      expect(screen.getByTestId(`choice-${name}-do_it`)).not.toHaveAttribute('title');
      expect(screen.getByTestId(`choice-${name}-do_it`)).not.toHaveAttribute('aria-disabled');
      expect(screen.queryByTestId(`choice-why-${name}`)).toBeNull();
    }
  });

  it('all three live on a positively read-only tool, with no reason anywhere', async () => {
    show(tool());
    expect(screen.getByTestId('choice-shopify.get_order-do_it')).toBeEnabled();
    expect(screen.getByTestId('choice-shopify.get_order-do_it')).not.toHaveAttribute('title');
  });

  it('★ always all three, in 02’s order', async () => {
    const { container } = show(tool({ riskGroup: 'financial' }));
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Do it',
      'Ask me',
      'Never',
    ]);
  });

  it('★ never a locked segment without its reason', async () => {
    // A greyed control with no sentence reads as a defect or a plan upgrade.
    const { container } = show(tool({ riskGroup: 'financial' }));
    const locked = container.querySelectorAll('button[aria-disabled="true"], button[disabled]');
    expect(locked).toHaveLength(1);
    for (const button of locked) {
      expect(button.getAttribute('title')).toBeTruthy();
    }
  });

  it('★ one line under the control, and only the reason', async () => {
    const { container } = show(tool({ riskGroup: 'financial' }));
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });
});

describe('★★ a stored state the ceiling would now forbid', () => {
  it('★★ is SHOWN as the current one, and its segment says it cannot be set back', async () => {
    /*
     * A financial tool stored as auto-approve - set before this ceiling
     * existed, or by curl. Hiding it would be worse than showing it: an
     * admin cannot turn off a setting the screen will not show them.
     */
    show(tool({ toolName: 'r', riskGroup: 'financial', enabled: true, requiresApproval: false }));
    const doIt = screen.getByTestId('choice-r-do_it');
    expect(doIt).toHaveAttribute('data-current', 'yes');
    expect(doIt).toHaveAttribute('aria-disabled', 'true');
    expect(doIt).toHaveAttribute('title', expect.stringMatching(/can't be set back/i));
    expect(screen.getByTestId('choice-why-r')).toHaveTextContent(/can't be set back/i);
    // But turning it off is available.
    expect(screen.getByTestId('choice-r-never')).toBeEnabled();
  });

  it('★ says nothing extra when the stored state is within the ceiling', async () => {
    show(tool({ toolName: 'ok', riskGroup: 'read_only', requiresApproval: false }));
    expect(screen.getByTestId('choice-ok-do_it')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('choice-ok-do_it')).not.toHaveAttribute('title');
    expect(screen.queryByTestId('choice-why-ok')).toBeNull();
  });

  it('marks the current choice', async () => {
    show(tool({ toolName: 'c', enabled: false }));
    expect(screen.getByTestId('choice-c-never')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('choice-c-ask_me')).toHaveAttribute('data-current', 'no');
  });
});

describe('★★ blocked - the platform decides, so nothing can be chosen', () => {
  it('all three disabled with the reason, the stored one marked, and no click writes', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
        <PermissionChoice capability={tool()} blocked="Reconnect Shopify first." />
      </NextIntlClientProvider>,
    );
    for (const choice of ['do_it', 'ask_me', 'never'] as const) {
      const button = screen.getByTestId(`choice-shopify.get_order-${choice}`);
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(button).not.toHaveAttribute('aria-describedby');
      expect(button).toHaveAttribute('title', 'Reconnect Shopify first.');
      await userEvent.click(button);
    }
    // Said once above the list, not again on the row.
    expect(screen.queryByTestId('choice-why-shopify.get_order')).toBeNull();
    expect(screen.getByTestId('choice-shopify.get_order-ask_me')).toHaveAttribute(
      'data-current',
      'yes',
    );
    expect(setToolPermission).not.toHaveBeenCalled();
  });
});

/*
 * S2 (Omer, 2026-10-11): loosening a tool that touches customer details to
 * "Do it" asks once, on the row. Nothing else confirms. The action is the
 * mock above; each test here lets it answer once.
 */
describe('★★ one confirm - customer details to "Do it"', () => {
  const write = vi.mocked(setToolPermission);
  beforeEach(() => {
    write.mockClear();
  });

  it('★★ sensitive_data: Do it asks first; Cancel writes nothing; Continue writes do_it', async () => {
    const sd = tool({ toolName: 'sd', riskGroup: 'sensitive_data' });
    show(sd);
    await userEvent.click(screen.getByTestId('choice-sd-do_it'));
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByTestId('choice-confirm-sd')).toHaveTextContent(
      'GOTCHA will do this without asking. It touches customer details. Continue?',
    );
    await userEvent.click(screen.getByTestId('choice-confirm-sd-no'));
    expect(screen.queryByTestId('choice-confirm-sd')).toBeNull();
    expect(write).not.toHaveBeenCalled();

    write.mockResolvedValueOnce({ ok: true });
    await userEvent.click(screen.getByTestId('choice-sd-do_it'));
    await userEvent.click(screen.getByTestId('choice-confirm-sd-yes'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(sd, 'do_it');
    expect(screen.queryByTestId('choice-confirm-sd')).toBeNull();
  });

  it('from Never too', async () => {
    show(tool({ toolName: 'sd', riskGroup: 'sensitive_data', enabled: false }));
    await userEvent.click(screen.getByTestId('choice-sd-do_it'));
    expect(screen.getByTestId('choice-confirm-sd')).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it('★ no confirm for create_update to Do it, or for sensitive_data to Never', async () => {
    write.mockResolvedValue({ ok: true });
    show(tool({ toolName: 'cu', riskGroup: 'create_update' }));
    await userEvent.click(screen.getByTestId('choice-cu-do_it'));
    expect(screen.queryByTestId('choice-confirm-cu')).toBeNull();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'cu' }), 'do_it');

    show(tool({ toolName: 'sd', riskGroup: 'sensitive_data' }));
    await userEvent.click(screen.getByTestId('choice-sd-never'));
    expect(screen.queryByTestId('choice-confirm-sd')).toBeNull();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'sd' }), 'never');
    write.mockReset();
    write.mockImplementation(async () => {
      throw new Error('a test must never call setToolPermission');
    });
  });

  it('★★ the server keeping approval (422) is said as a sentence', async () => {
    write.mockResolvedValueOnce({ ok: false, reason: 'approval_cannot_be_removed' });
    show(tool({ toolName: 'cu', riskGroup: 'create_update' }));
    await userEvent.click(screen.getByTestId('choice-cu-do_it'));
    expect(screen.getByTestId('choice-problem-cu')).toHaveTextContent(
      "GOTCHA can't do this one without asking: it deletes something, moves money or changes settings. It still comes to Approvals.",
    );
  });
});
