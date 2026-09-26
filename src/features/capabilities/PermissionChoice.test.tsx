import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { capabilitySchema, type Capability } from '@/api/contracts/capabilities';
import messages from '@/i18n/messages/en/capabilities.json';

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

describe('★★ "Do it" is absent where it may not be chosen, and says why', () => {
  it('★★ offers two buttons on a tool that changes orders or money', async () => {
    show(tool({ toolName: 'shopify.process_refund', riskGroup: 'financial' }));
    expect(screen.queryByTestId('choice-shopify.process_refund-do_it')).toBeNull();
    expect(screen.getByTestId('choice-shopify.process_refund-ask_me')).toBeInTheDocument();
    expect(screen.getByTestId('choice-shopify.process_refund-never')).toBeInTheDocument();
    expect(screen.getByTestId('no-automation-shopify.process_refund')).toHaveTextContent(
      /changes orders or money/i,
    );
  });

  it('★★ and on `create_update`, which is the no-match fallback', async () => {
    /*
     * `shopify.cancel_order` lands in `create_update` because neither
     * "cancel" nor "return" is in any of the four risk patterns, and the
     * platform's own `mayBeAlwaysAllowed` says TRUE for it. The design puts
     * it under "Changing orders and money · Comes to Approvals".
     *
     * The sentence is the OTHER one: we could not tell, not "this moves
     * money" — a reader can act on the first and would be misled by the
     * second.
     */
    show(tool({ toolName: 'shopify.cancel_order', riskGroup: 'create_update' }));
    expect(screen.queryByTestId('choice-shopify.cancel_order-do_it')).toBeNull();
    expect(screen.getByTestId('no-automation-shopify.cancel_order')).toHaveTextContent(
      /can't tell what this one changes/i,
    );
  });

  it('offers all three on a positively read-only tool', async () => {
    show(tool());
    expect(screen.getByTestId('choice-shopify.get_order-do_it')).toBeInTheDocument();
    expect(screen.queryByTestId('no-automation-shopify.get_order')).toBeNull();
  });

  it('★ never renders a disabled "Do it" with no reason beside it', async () => {
    // A greyed control with no sentence reads as a defect or a plan upgrade.
    const { container } = show(tool({ riskGroup: 'financial' }));
    const disabledButtons = [...container.querySelectorAll('button[disabled]')];
    expect(disabledButtons).toHaveLength(0);
  });
});

describe('★★ a stored state the ceiling would now forbid', () => {
  it('★★ shows it, and says it cannot be set back', async () => {
    /*
     * A financial tool stored as auto-approve — set before this ceiling
     * existed, or by curl, since `PUT /api/tool-permissions/:toolName` does
     * not call `mayBeAlwaysAllowed`.
     *
     * Hiding it would be worse than showing it: an admin cannot turn off a
     * setting the screen will not show them, and this is the one setting
     * where leaving it on means refunds go through unattended.
     */
    show(tool({ toolName: 'r', riskGroup: 'financial', enabled: true, requiresApproval: false }));
    expect(screen.getByTestId('stored-automatic-r')).toHaveTextContent(/set to run on its own/i);
    expect(screen.getByTestId('stored-automatic-r')).toHaveTextContent(/can't be set back/i);
    // And the option to restore it is still absent.
    expect(screen.queryByTestId('choice-r-do_it')).toBeNull();
    // But turning it off is available.
    expect(screen.getByTestId('choice-r-never')).toBeInTheDocument();
  });

  it('★ says nothing extra when the stored state is within the ceiling', async () => {
    show(tool({ toolName: 'ok', riskGroup: 'read_only', requiresApproval: false }));
    expect(screen.queryByTestId('stored-automatic-ok')).toBeNull();
  });

  it('marks the current choice', async () => {
    show(tool({ toolName: 'c', enabled: false }));
    expect(screen.getByTestId('choice-c-never')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('choice-c-ask_me')).toHaveAttribute('data-current', 'no');
  });
});
