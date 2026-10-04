import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Capability, ToolUsage } from '@/api/contracts/capabilities';
import { integrationSchema } from '@/api/contracts/integrations';
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
  riskLevel: null,
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

const renderScreen = async (
  capabilities: readonly Capability[],
  usage: readonly ToolUsage[] | null = null,
) =>
  render(
    /*
     * Wrapped, because `PermissionChoice` is a CLIENT component inside this
     * server tree and `useTranslations` needs a context the server mock does
     * not supply. Sixth time this session — the tell is always the same
     * sentence about `NextIntlClientProvider`, and it names the component
     * rather than the harness.
     */
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      {await CapabilityScreen({ capabilities, usage })}
    </NextIntlClientProvider>,
  );

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

describe('★★ the fourth state, on screen', () => {
  it('★★ a blocked row keeps its control — disabled, its state marked, the repair in a title', async () => {
    /*
     * 06's ruling (states, not explanations): the earlier red sentence on
     * every row is gone. The three segments stay, the stored one marked, and
     * none can be pressed while the platform decides.
     */
    await renderScreen([
      capability({
        toolName: 'shopify.process_refund',
        integrationConnected: false,
        enabled: true,
        requiresApproval: true,
      }),
    ]);
    const control = screen.getByTestId('choice-shopify.process_refund');
    expect(control).toHaveAttribute('data-blocked', 'yes');
    for (const choice of ['do_it', 'ask_me', 'never']) {
      const button = screen.getByTestId(`choice-shopify.process_refund-${choice}`);
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toMatch(/reconnect it/i);
    }
    expect(screen.getByTestId('choice-shopify.process_refund-ask_me')).toHaveAttribute(
      'data-current',
      'yes',
    );
    expect(screen.getByTestId('capability-screen')).not.toHaveTextContent(/reconnect it/i);
  });

  it('★★ names the missing scopes — in the title, not beside the row', async () => {
    await renderScreen([
      capability({
        toolName: 'shopify.refund',
        scopeBlocked: true,
        missingScopes: ['write_orders', 'read_returns'],
      }),
    ]);
    const title = screen.getByTestId('choice-shopify.refund-never').getAttribute('title');
    expect(title).toMatch(/write_orders/);
    expect(title).toMatch(/read_returns/);
  });

  it('★★ a system that is down is said ONCE, above its rows; names from its catalogue; no "meta" head', async () => {
    const shopify = integrationSchema.parse({
      id: 'i1',
      slug: 'shopify',
      name: 'Shopify',
      catalogTools: [
        { id: 't1', slug: 'add_vip_tag', name: 'Add VIP Tag' },
        { id: 't2', slug: 'check_delivery_eta', name: 'Check Delivery ETA' },
      ],
    });
    const row = (slug: string) =>
      capability({
        toolName: `shopify.${slug}`,
        integration: 'shopify',
        kind: 'integration',
        category: 'meta',
        integrationConnected: false,
      });
    render(
      <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
        {await CapabilityScreen({
          capabilities: [
            row('add_vip_tag'),
            row('check_delivery_eta'),
            row('add_customer_to_segment'),
          ],
          usage: null,
          integration: shopify,
        })}
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByTestId('system-down')).toHaveLength(1);
    // Shopify re-authorises from here (backend 381a5d1b): the repair beside the line.
    expect(screen.getByTestId('oauth-start')).toHaveTextContent('Reconnect Shopify');
    expect(screen.getByTestId('system-down')).toHaveTextContent(
      'Hidden from GOTCHA while Shopify needs fixing — reconnect it in Integrations.',
    );
    expect(screen.getByTestId('capability-shopify.add_vip_tag')).toHaveTextContent(/^Add VIP tag/);
    expect(screen.getByTestId('capability-shopify.check_delivery_eta')).toHaveTextContent(
      /^Check delivery ETA/,
    );
    // Not in the catalogue: the slug, without the provider.
    expect(screen.getByTestId('capability-shopify.add_customer_to_segment')).toHaveTextContent(
      /^Add customer to segment/,
    );
    expect(screen.getByTestId('capability-screen')).not.toHaveTextContent(
      /WhatsApp and Instagram/i,
    );
  });

  it('★★ an unknown provider keeps its control, and is not greyed out', async () => {
    /*
     * `integrationConnected: undefined` is "we have no record of this
     * provider", which the route deliberately separates from
     * "disconnected". Greying it out would tell an admin to reconnect
     * something that is connected.
     */
    await renderScreen([capability({ toolName: 'send_message', integrationConnected: undefined })]);
    // The control is offered. (It is `choice-…` since the three-state
    // control replaced the read-only stance label — the claim is the same.)
    expect(screen.getByTestId('choice-send_message')).toBeInTheDocument();
    expect(screen.queryByTestId('blocked-send_message')).toBeNull();
  });

  it('★ a row the admin turned off still reads as their choice', async () => {
    // `disabled` with `reason: 'ok'` — the switch is theirs and it is off.
    // That must not render as the platform blocking them.
    await renderScreen([capability({ toolName: 'delete_contact', enabled: false })]);
    expect(screen.getByTestId('choice-delete_contact')).toBeInTheDocument();
    expect(screen.queryByTestId('blocked-delete_contact')).toBeNull();
    /*
     * ★ AND "Never" READS AS THEIRS. `disabled` with `reason: 'ok'` means the
     * admin turned it off — the control shows that as the current choice
     * rather than as the platform blocking them.
     */
    expect(screen.getByTestId('choice-delete_contact-never')).toHaveAttribute(
      'data-current',
      'yes',
    );
  });
});

describe('★★ how often it has run, and what that does not prove', () => {
  const ran = (over: Partial<ToolUsage> = {}): ToolUsage => ({
    toolName: 'close_conversation',
    executionCount: 612,
    successCount: 612,
    refusedCount: 0,
    erroredCount: 0,
    unclassifiedFailureCount: 0,
    successRate: 100,
    avgDurationMs: 120,
    ...over,
  });

  it('shows the count beside the setting', async () => {
    await renderScreen([capability()], [ran()]);
    expect(screen.getByTestId('used-close_conversation')).toHaveTextContent(/Used 612 times/i);
  });

  it('★★ will not say "never failed" while attempts are unclassified', async () => {
    /*
     * THE DESIGN'S CAPTION, AND WHY IT NEEDS A THIRD ANSWER.
     *
     * Attempts written before the platform recorded a failure reason land in
     * `unclassifiedFailureCount` and are deliberately NOT counted as errors —
     * the service refuses to guess whether they were refusals or breakages.
     * So `erroredCount === 0` does not support "never failed"; it supports
     * "nothing we can read failed", which is a different sentence and the
     * screen says neither.
     */
    await renderScreen([capability()], [ran({ unclassifiedFailureCount: 3 })]);
    const used = screen.getByTestId('used-close_conversation');
    expect(used).toHaveTextContent(/Used 612 times/i);
    expect(used).not.toHaveTextContent(/never failed/i);
    expect(used).not.toHaveTextContent(/failed 0/i);
  });

  it('says it plainly when nothing is unclassified', async () => {
    await renderScreen([capability()], [ran()]);
    expect(screen.getByTestId('used-close_conversation')).toHaveTextContent(/never failed/i);
  });

  it('★★ a refusal is never reported as a failure', async () => {
    /*
     * *"A refusal is the product working correctly, and guessing would make a
     * functioning approval policy read as a broken integration."* A tool a
     * rule keeps stopping and a tool that keeps breaking need opposite
     * repairs — one is a policy review, the other is an outage.
     */
    await renderScreen([capability()], [ran({ refusedCount: 41, successCount: 571 })]);
    const used = screen.getByTestId('used-close_conversation');
    expect(used).toHaveTextContent(/stopped 41 times by a rule/i);
    /*
     * ★ ASSERTED AGAINST A FAILURE COUNT, NOT AGAINST THE WORD.
     *
     * The first version excluded only "failed 41", and a mutation folding
     * refusals into failures rendered "failed 0 times" and passed it. The
     * second excluded /failed/ outright and failed on correct code, because
     * "never failed" contains it — which is the right answer here: 41
     * refusals with no errors genuinely never failed.
     *
     * So the claim to exclude is a failure COUNT. Both wrong assertions were
     * found by mutation testing, and neither by reading.
     */
    expect(used).not.toHaveTextContent(/failed (once|\d+ times)/i);
    expect(used).toHaveTextContent(/never failed/i);
  });

  it('★★ a failed usage read prints no count at all, never a zero', async () => {
    // "Used 0 times" is a claim about the tool. A failed or unpermitted read
    // is a fact about us, and the row simply carries no history.
    await renderScreen([capability()], null);
    expect(screen.queryByTestId('used-close_conversation')).toBeNull();
  });

  it('★ a tool that has genuinely never run says nothing either', async () => {
    // Zero executions is real, but "used 0 times" beside a permission reads
    // as a reproach. The absence of a count is the honest rendering.
    await renderScreen([capability()], [ran({ executionCount: 0, successCount: 0 })]);
    expect(screen.queryByTestId('used-close_conversation')).toBeNull();
  });
});

describe('★★ 02’s row: what it is, how it ran, one control — and nothing beside it', () => {
  it('★ without a run to count, the state says what happens instead', async () => {
    await renderScreen([
      capability({ toolName: 'asks', requiresApproval: true }),
      capability({ toolName: 'off', enabled: false }),
    ]);
    expect(screen.getByTestId('ran-asks')).toHaveTextContent('Comes to Approvals');
    expect(screen.getByTestId('ran-off')).toHaveTextContent('Switched off');
  });

  it('★ a counted run wins over the state line', async () => {
    await renderScreen(
      [capability({ toolName: 'asks', requiresApproval: true })],
      [
        {
          toolName: 'asks',
          executionCount: 4,
          erroredCount: 0,
          unclassifiedFailureCount: 0,
          refusedCount: 0,
        } as ToolUsage,
      ],
    );
    expect(screen.getByTestId('used-asks')).toBeInTheDocument();
    expect(screen.queryByTestId('ran-asks')).toBeNull();
  });

  it('★★ why "Do it" is greyed is said ONCE at the foot, never on each row', async () => {
    await renderScreen([
      capability({ toolName: 'a', riskGroup: 'financial' }),
      capability({ toolName: 'b', riskGroup: 'financial' }),
    ]);
    expect(screen.getAllByTestId('ceiling-note')).toHaveLength(1);
    expect(screen.queryByText(/changes orders or money, so it can be asked/i)).toBeNull();
  });

  it('no foot line when every action may be automated', async () => {
    await renderScreen([capability({ riskGroup: 'read_only' })]);
    expect(screen.queryByTestId('ceiling-note')).toBeNull();
  });
});

describe('★ the catalogue’s risk, on integration rows (backend 3cee674f)', () => {
  it('stored risk is said; a built-in row has none', async () => {
    await renderScreen([
      capability({
        toolName: 'shopify.cancel_order',
        integration: 'shopify',
        category: 'meta',
        riskLevel: 'HIGH',
      }),
      capability({ toolName: 'send_message' }),
    ]);
    expect(screen.getByTestId('risk-shopify.cancel_order')).toHaveTextContent('High risk');
    expect(screen.getByTestId('risk-shopify.cancel_order')).toHaveAttribute('data-risk', 'HIGH');
    expect(screen.queryByTestId('risk-send_message')).toBeNull();
  });
});

describe('★ Reconnect only where the way back comes here', () => {
  it('a credentials system that is down says so, with no OAuth button', async () => {
    const woo = integrationSchema.parse({ id: 'i2', slug: 'woocommerce', name: 'WooCommerce' });
    render(
      <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
        {await CapabilityScreen({
          capabilities: [
            capability({
              toolName: 'woocommerce.get_order',
              integration: 'woocommerce',
              integrationConnected: false,
            }),
          ],
          usage: null,
          integration: woo,
        })}
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('system-down')).toBeInTheDocument();
    expect(screen.queryByTestId('oauth-start')).toBeNull();
  });
});

describe('★ 10 groups an integration by the catalogue’s category', () => {
  it('ACTION, WRITE, READ heads in that order; no category, no head', async () => {
    const shopify = integrationSchema.parse({ id: 'i1', slug: 'shopify', name: 'Shopify' });
    const row = (slug: string, category: string | null) =>
      capability({
        toolName: `shopify.${slug}`,
        integration: 'shopify',
        category: category as never,
      });
    render(
      <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
        {await CapabilityScreen({
          capabilities: [
            row('get_order', 'READ'),
            row('cancel_order', 'WRITE'),
            row('send_invoice', 'ACTION'),
            row('mystery', ''),
          ],
          usage: null,
          integration: shopify,
        })}
      </NextIntlClientProvider>,
    );
    const heads = [...screen.getByTestId('capability-screen').querySelectorAll('h2')].map(
      (h) => h.textContent,
    );
    expect(heads).toEqual(['Actions', 'Changing things', 'Looking things up']);
    expect(screen.getByTestId('group-none').querySelector('h2')).toBeNull();
    expect(screen.getByTestId('group-none')).toHaveTextContent('Mystery');
  });
});

describe('★ built-in actions keep their stored category', () => {
  it('a head per category, keyed by it', async () => {
    await renderScreen([capability({ toolName: 'send_message', category: 'messaging' })]);
    expect(screen.getByTestId('group-messaging').querySelector('h2')).toHaveTextContent(
      messages.category.messaging,
    );
  });
});
