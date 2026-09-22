import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Capability } from '@/api/contracts/capabilities';
import messages from '@/i18n/messages/en/capabilities.json';

import { CapabilityScreen } from './CapabilityScreen';

/**
 * That the platform's own tool descriptions never reach a merchant's screen.
 *
 * Those strings are written for whoever **calls** the tool:
 *
 *   *"Mark the current conversation as resolved (autonomous bot only)."*
 *   *"Returns a draft body; use `schedule_followup` … to actually dispatch it."*
 *
 * Seventeen rows of that is an API reference on a shopkeeper's screen, and it
 * names other tools by their function names. This app has its own words.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages }, namespace }),
}));

const capability = (over: Partial<Capability> = {}): Capability => ({
  toolName: 'close_conversation',
  kind: 'action',
  category: 'messaging',
  // The platform's own prose, passed in exactly as the route sends it.
  description: 'Mark the current conversation as resolved (autonomous bot only).',
  enabled: true,
  requiresApproval: true,
  isDefault: true,
  approverRole: null,
  expiresAfterMin: 30,
  allowModification: false,
  riskGroup: 'create_update',
  integration: null,
  ...over,
});

const renderScreen = async (capabilities: readonly Capability[]) =>
  render(await CapabilityScreen({ capabilities }));

describe('our words, not the platform’s', () => {
  it('replaces the API prose with a merchant sentence', async () => {
    await renderScreen([capability()]);
    expect(screen.getByTestId('capability-close_conversation')).toHaveTextContent(
      /marks? a conversation finished/i,
    );
  });

  it('never renders the description it was given', async () => {
    await renderScreen([capability()]);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/autonomous bot only/i);
    expect(text).not.toMatch(/`|Returns |adapter/);
  });

  it('carries no developer prose in any of its own words', async () => {
    // The whole catalogue, not just the rows rendered above — a sentence
    // added later must pass the same bar.
    for (const [name, words] of Object.entries(messages.tool as Record<string, string>)) {
      expect(words, name).not.toMatch(/`|autonomous bot|Returns |adapter|CRM adapter/i);
    }
  });

  it('falls back to the tool name for something it has no words for', async () => {
    // Not to the platform prose. A missing translation should look like one.
    await renderScreen([
      capability({
        toolName: 'shopify.cancel_order',
        description: 'Cancels an order via the Shopify adapter. Returns the order object.',
      }),
    ]);
    expect(screen.getByTestId('capability-shopify.cancel_order')).toHaveTextContent(
      /Shopify cancel order/i,
    );
    expect(document.body.textContent).not.toMatch(/adapter|Returns /);
  });
});

describe('the uniform facts are stated only when they are uniform', () => {
  it('states them when every row agrees', async () => {
    await renderScreen([capability({ toolName: 'a' }), capability({ toolName: 'b' })]);
    expect(screen.getByTestId('all-default')).toBeInTheDocument();
    expect(screen.getByTestId('expiry')).toHaveTextContent(/30 minutes/);
  });

  it('withholds a claim the rows do not support', async () => {
    // One row on a different expiry means "every approval expires after 30
    // minutes" is no longer true, and the sentence must disappear rather
    // than quietly describe the first row.
    await renderScreen([
      capability({ toolName: 'a', expiresAfterMin: 30 }),
      capability({ toolName: 'b', expiresAfterMin: 60 }),
    ]);
    expect(screen.queryByTestId('expiry')).toBeNull();
    // Positive control: the others still render, so the absence above is the
    // claim being withheld rather than the block failing to draw.
    expect(screen.getByTestId('all-default')).toBeInTheDocument();
  });
});
