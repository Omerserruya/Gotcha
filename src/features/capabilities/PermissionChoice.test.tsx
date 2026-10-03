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

/*
 * Superseded in form (S2, 2026-10-03): 02's control is ALWAYS three, the
 * stored one dark. "Do it" where it may not be chosen was absent; it is now
 * DISABLED, with its reason on itself. The rule is unchanged: it cannot be
 * chosen, and the screen says why.
 */
describe('★★ "Do it" is disabled where it may not be chosen, and says why on itself', () => {
  it('★★ a tool that changes orders or money: Do it disabled, with the reason', async () => {
    show(tool({ toolName: 'shopify.process_refund', riskGroup: 'financial' }));
    const doIt = screen.getByTestId('choice-shopify.process_refund-do_it');
    expect(doIt).toBeDisabled();
    expect(doIt).toHaveAttribute('title', expect.stringMatching(/changes orders or money/i));
    expect(screen.getByTestId('choice-shopify.process_refund-ask_me')).toBeEnabled();
    expect(screen.getByTestId('choice-shopify.process_refund-never')).toBeEnabled();
  });

  it('★★ and on `create_update`, the no-match fallback — the OTHER sentence', async () => {
    // "We could not tell", not "this moves money": a reader can act on the
    // first and would be misled by the second.
    show(tool({ toolName: 'shopify.cancel_order', riskGroup: 'create_update' }));
    expect(screen.getByTestId('choice-shopify.cancel_order-do_it')).toHaveAttribute(
      'title',
      expect.stringMatching(/can't tell what this one changes/i),
    );
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

  it('★ never a disabled segment without its reason', async () => {
    // A greyed control with no sentence reads as a defect or a plan upgrade.
    const { container } = show(tool({ riskGroup: 'financial' }));
    for (const button of container.querySelectorAll('button[disabled]')) {
      expect(button.getAttribute('title')).toBeTruthy();
    }
  });

  it('★ and no explanation beside the row — states, not explanations', async () => {
    const { container } = show(tool({ riskGroup: 'financial' }));
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});

describe('★★ a stored state the ceiling would now forbid', () => {
  it('★★ is SHOWN as the current one, and its segment says it cannot be set back', async () => {
    /*
     * A financial tool stored as auto-approve — set before this ceiling
     * existed, or by curl. Hiding it would be worse than showing it: an
     * admin cannot turn off a setting the screen will not show them.
     */
    show(tool({ toolName: 'r', riskGroup: 'financial', enabled: true, requiresApproval: false }));
    const doIt = screen.getByTestId('choice-r-do_it');
    expect(doIt).toHaveAttribute('data-current', 'yes');
    expect(doIt).toBeDisabled();
    expect(doIt).toHaveAttribute('title', expect.stringMatching(/can't be set back/i));
    // But turning it off is available.
    expect(screen.getByTestId('choice-r-never')).toBeEnabled();
  });

  it('★ says nothing extra when the stored state is within the ceiling', async () => {
    show(tool({ toolName: 'ok', riskGroup: 'read_only', requiresApproval: false }));
    expect(screen.getByTestId('choice-ok-do_it')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('choice-ok-do_it')).not.toHaveAttribute('title');
  });

  it('marks the current choice', async () => {
    show(tool({ toolName: 'c', enabled: false }));
    expect(screen.getByTestId('choice-c-never')).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId('choice-c-ask_me')).toHaveAttribute('data-current', 'no');
  });
});
