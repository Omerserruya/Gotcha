import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import messages from '@/i18n/messages/en/systems.json';

import { CapabilityControls } from './CapabilityControls';
import type { CapabilityRow, SystemRow } from './rows';

/**
 * Screen 14d — the three states, the value shown, the save disabled.
 *
 * Every one of these is unreachable by a capture on this tenant in the
 * interesting direction: the only integration is in ERROR, so `cannotHere`
 * never renders and no stance other than the seeded ones is ever on screen.
 * The states that MATTER for correctness are therefore asserted here, where
 * they can be constructed.
 */

const t = createTranslator({
  locale: 'en',
  messages: { systems: messages },
  namespace: 'systems',
}) as unknown as Parameters<typeof CapabilityControls>[0]['t'];

function capability(over: Partial<CapabilityRow> = {}): CapabilityRow {
  return { id: 'c1', slug: 'process_refund', name: 'Process Refund', stance: 'allow', ...over };
}

function system(over: Partial<SystemRow> = {}): SystemRow {
  return {
    id: 's1',
    slug: 'shopify',
    name: 'Shopify',
    description: null,
    failing: true,
    lastCheckedAt: null,
    error: null,
    repairableHere: false,
    capabilitiesRunning: false,
    capabilities: [capability()],
    ...over,
  } as SystemRow;
}

describe('CapabilityControls', () => {
  it('shows the current value as the chosen state, not as a label', () => {
    render(
      <CapabilityControls row={system({ capabilities: [capability({ stance: 'ask' })] })} t={t} />,
    );

    // The control exists and carries the value. A screen that printed the
    // word "Asks first" without a control would not be showing a SETTING.
    const chosen = screen.getByRole('radio', { name: /Asks first/i }) as HTMLInputElement;
    expect(chosen.checked).toBe(true);
    expect(screen.getByRole('radio', { name: /On its own/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^Never$/i })).not.toBeChecked();
  });

  it('renders all three states for every capability, always', () => {
    // Not "the current one plus the others where they differ". A merchant
    // cannot see what a setting COULD be from a screen that draws only what
    // it is.
    render(<CapabilityControls row={system()} t={t} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('disables every control', () => {
    /*
     * The whole point of the ruling. `PUT /api/tool-permissions/:toolName`
     * answers 409 while the integration is disconnected, so an enabled
     * control is a button that fails on click every time — which teaches a
     * merchant the page is broken rather than that their shop is.
     */
    render(<CapabilityControls row={system()} t={t} />);
    for (const input of screen.getAllByRole('radio')) expect(input).toBeDisabled();
  });

  it('says WHY it cannot be saved, and names the system when the reason is the connection', () => {
    render(<CapabilityControls row={system({ capabilitiesRunning: false })} t={t} />);
    const locked = screen.getByTestId('tools-locked-shopify');
    expect(locked.textContent).toMatch(/Shopify/);
    expect(locked.textContent).toMatch(/written together/i);
  });

  it('does NOT blame the connection when the system is working', () => {
    /*
     * ★ THE ONE THIS FILE EXISTS FOR.
     *
     * A single locked sentence would have read "these can't be changed while
     * Shopify isn't working" on a tenant whose Shopify is fine — sending
     * somebody to repair something that is not broken, which is the most
     * expensive kind of wrong sentence a settings screen can carry.
     *
     * No capture can reach this: our only integration is in ERROR.
     */
    render(<CapabilityControls row={system({ capabilitiesRunning: true })} t={t} />);
    const locked = screen.getByTestId('tools-locked-shopify');
    expect(locked.textContent).toMatch(/can.t be changed from this screen/i);
    expect(locked.textContent).not.toMatch(/isn.t working/i);
    expect(locked.textContent).not.toMatch(/Shopify/);
  });

  it('says what “asks first” actually does', () => {
    // `requiresApproval` creates a real ApprovalRequest and holds the
    // conversation. Naming the queue is the difference between a label and a
    // description of what happens.
    render(<CapabilityControls row={system()} t={t} />);
    const note = screen.getByTestId('tools-ask-means-shopify');
    expect(note.textContent).toMatch(/Approvals queue/i);
    expect(note.textContent).toMatch(/waits|waiting/i);
  });

  it('renders nothing at all when the policy read failed', () => {
    /*
     * `stance: null` means we could not check. Drawing three radios with
     * none selected would look like "nothing is configured"; drawing them
     * with "Never" selected would be a guess in the safe-looking direction
     * about whether an AI may issue refunds. Both are worse than silence,
     * and `stance-unknown-<slug>` above already says so.
     */
    const { container } = render(
      <CapabilityControls row={system({ capabilities: [capability({ stance: null })] })} t={t} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the restricted ones first', () => {
    const row = system({
      capabilities: [
        capability({ id: 'a', slug: 'a', name: 'Allowed thing', stance: 'allow' }),
        capability({ id: 'b', slug: 'b', name: 'Off thing', stance: 'never' }),
      ],
    });
    render(<CapabilityControls row={row} t={t} />);
    const names = screen.getAllByRole('group').map((g) => g.textContent ?? '');
    expect(names[0]).toMatch(/Off thing/);
  });

  it('counts only the capabilities it can actually show', () => {
    // The summary is the only thing visible while collapsed, so a count that
    // included unreadable stances would promise rows that are not inside.
    const row = system({
      capabilities: [
        capability({ id: 'a', slug: 'a' }),
        capability({ id: 'b', slug: 'b', stance: null }),
      ],
    });
    render(<CapabilityControls row={row} t={t} />);
    expect(screen.getByTestId('tools-summary-shopify').textContent).toMatch(/\b1\b/);
  });
});
