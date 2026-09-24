import { render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { businessCoreSchema } from '@/api/contracts/business-core';
import messages from '@/i18n/messages/en/business-core.json';

import { BusinessCore } from './BusinessCore';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'business-core') =>
    createTranslator({ locale: 'en', messages: { 'business-core': messages }, namespace }),
}));

/** The estate as measured. */
const MEASURED = {
  useCase: 'both',
  roles: [
    {
      role: 'ecommerce',
      candidates: [{ slug: 'shopify', name: 'Shopify', connected: false, status: 'ERROR' }],
    },
    {
      role: 'payments',
      candidates: [
        { slug: 'stripe', name: 'Stripe', connected: false, status: null },
        { slug: 'paypal', name: 'PayPal', connected: false, status: null },
      ],
    },
    { role: 'shipping', available: false, reason: 'no_integrations_exist', candidates: [] },
    {
      role: 'crm',
      candidates: [{ slug: 'hubspot', name: 'HubSpot', connected: false, status: null }],
    },
  ],
  catalogueNotes: ['ReturnGO is stored under the ecommerce category but serves returns.'],
};

/*
 * Wrapped in the client provider, because 14c's election control is a client
 * component inside this server tree and `useTranslations` needs a context the
 * server's `getTranslations` mock does not supply.
 *
 * Worth naming: the first run after mounting ElectPart failed with "the
 * context from NextIntlClientProvider was not found", pointing at the
 * component. It was the harness, not the subject — the fifth time this
 * session that a test-environment gap has arrived wearing the screen's
 * clothes. The tell is the same every time: the failure describes the
 * RENDERER's situation, not the product's.
 */
const render14 = async (over: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ 'business-core': messages }}>
      {await BusinessCore({ core: businessCoreSchema.parse({ ...MEASURED, ...over }) })}
    </NextIntlClientProvider>,
  );

describe('★ "connect one" is the wrong instruction for a broken connection', () => {
  it('tells the merchant to FIX Shopify, not to connect it', async () => {
    /*
     * They already connected it. An empty dropdown, or "nothing connected",
     * sends somebody to the marketplace to redo work they have done.
     */
    await render14();
    const part = screen.getByTestId('core-part-ecommerce');
    expect(part).toHaveAttribute('data-state', 'connected_but_failing');

    const failing = within(part).getByTestId('core-part-failing');
    expect(failing).toHaveTextContent(/Shopify is connected and not working/i);
    expect(failing).toHaveTextContent(/rather than connecting it again/i);
    expect(part).not.toHaveTextContent(/nothing connected/i);
  });

  it('tells them to connect one where nothing was ever started', async () => {
    await render14();
    const part = screen.getByTestId('core-part-payments');
    expect(part).toHaveAttribute('data-state', 'nothing_connected');
    expect(within(part).getByTestId('core-part-nothing')).toHaveTextContent(
      /Stripe, PayPal would work/i,
    );
  });

  it('★ does not let one broken system hide a working one', async () => {
    // Checked after connected, so a healthy candidate wins the state.
    await render14({
      roles: [
        {
          role: 'payments',
          candidates: [
            { slug: 'a', name: 'A', connected: false, status: 'ERROR' },
            { slug: 'b', name: 'B', connected: true, status: 'CONNECTED' },
          ],
        },
      ],
    });
    expect(screen.getByTestId('core-part-payments')).toHaveAttribute(
      'data-state',
      'connected_none_chosen',
    );
  });
});

describe('★ a part nothing can serve is not the merchant’s failing', () => {
  it('says so rather than showing an empty choice', async () => {
    await render14();
    const shipping = screen.getByTestId('core-part-shipping');
    expect(shipping).toHaveAttribute('data-state', 'impossible');
    const note = within(shipping).getByTestId('core-part-impossible');
    expect(note).toHaveTextContent(/no shipping systems to connect/i);
    expect(note).toHaveTextContent(/not something you are missing/i);
  });

  it('never sends them to the marketplace for it', async () => {
    await render14();
    expect(
      within(screen.getByTestId('core-part-shipping')).queryByTestId('core-part-nothing'),
    ).toBeNull();
  });
});

describe('★ the CRM is chosen elsewhere and the screen says where', () => {
  it('explains the one part that cannot be configured here', async () => {
    /*
     * Unexplained, it looks identical to the four that can. And the reason is
     * worth giving: one place for the decision means this screen can never
     * disagree with the system the AI actually calls.
     */
    await render14();
    const crm = within(screen.getByTestId('core-part-crm')).getByTestId('core-part-crm-elsewhere');
    expect(crm).toHaveTextContent(/chosen on the Integrations screen/i);
    expect(crm).toHaveTextContent(/never disagree with the system the AI actually calls/i);
  });

  it('says nothing of the sort for the other parts', async () => {
    await render14();
    expect(
      within(screen.getByTestId('core-part-payments')).queryByTestId('core-part-crm-elsewhere'),
    ).toBeNull();
  });
});

describe('★ the caveat came out when it stopped being true', () => {
  it('no longer claims the election is unwired', async () => {
    /*
     * The election endpoint exists; its success and displacement paths are
     * covered by tests only, because nothing on this deployment is CONNECTED.
     * Offering the control as though it were proven is the implication this
     * sentence removes.
     */
    await render14();
    const note = screen.getByTestId('core-choosing');
    /*
     * ★ AND THE CAVEAT THAT STOOD HERE IS GONE, ON PURPOSE.
     *
     * For most of a day this screen said electing "does not change how the
     * AI behaves yet", because `config.roles` was read only by the
     * displacement logic inside its own write. Backend landed the read at
     * 2d1abf88 and the live bot path consumes it, so the sentence became
     * false and was deleted.
     *
     * This assertion is the other half of that: a caveat nobody is obliged
     * to revisit becomes a lie the day it stops being true, so the screen
     * must NOT still be carrying it.
     */
    expect(note).not.toHaveTextContent(/does not change how the AI behaves yet/i);
    expect(note).not.toHaveTextContent(/being built|once it is wired/i);
    // And names the exception, so "nothing works" is not the takeaway.
    expect(note).toHaveTextContent(/Customer records are the exception/i);
  });
});

describe('the use case decides which parts are asked about', () => {
  it('marks the chosen one and asks when there is none', async () => {
    await render14();
    expect(screen.getByTestId('core-use-case-both')).toHaveAttribute('data-selected', 'true');
    expect(screen.queryByTestId('core-use-case-unset')).toBeNull();

    const unset = await render14({ useCase: null });
    expect(unset.getByTestId('core-use-case-unset')).toHaveTextContent(/choose one/i);
  });

  it('explains why the question is asked at all', async () => {
    await render14();
    expect(screen.getByText(/never asked about shipping or returns/i)).toBeInTheDocument();
  });
});

describe('the platform’s catalogue notes', () => {
  it('renders them verbatim rather than re-deriving them', async () => {
    await render14();
    expect(screen.getByTestId('core-notes')).toHaveTextContent(
      /ReturnGO is stored under the ecommerce category/i,
    );
  });
});

describe('a failed read is not a business with no parts', () => {
  it('says we could not read it', async () => {
    render(await BusinessCore({ core: null }));
    expect(screen.getByTestId('core-unavailable')).toHaveTextContent(/could not read/i);
  });
});

describe('★ an inferred system is not a chosen one', () => {
  it('says returns FALLS BACK to Shopify rather than showing it as picked', async () => {
    /*
     * ★ THE ONE THAT INVENTS CONSENT IF IT IS WRONG.
     *
     * `returns` resolves to Shopify because the capability resolver found it
     * could serve returns. The prompt the model receives says so in
     * parentheses — "shopify (inferred, not chosen by the business)".
     *
     * Rendered through `state.chosen` it would read "Shopify does this", and
     * the next person to open this screen would believe a colleague had
     * decided that. A screen that manufactures a decision is worse than one
     * that shows nothing, because it is acted on.
     */
    await render14({
      roles: [
        {
          role: 'returns',
          elected: { slug: 'shopify', name: 'Shopify' },
          source: 'inferred',
          candidates: [{ slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' }],
        },
      ],
    });

    const inferred = screen.getByTestId('core-part-inferred');
    expect(inferred).toHaveTextContent(/nobody chose it/i);
    expect(inferred).toHaveTextContent(/falls back/i);
    // NOT the chosen sentence, which would claim a decision.
    expect(screen.queryByTestId('core-part-chosen')).toBeNull();
    expect(inferred).not.toHaveTextContent(/Shopify does this/i);
  });

  it('still calls a genuine election a choice', async () => {
    // The inferred branch must not swallow the real one: a merchant who DID
    // choose deserves to see that they did.
    await render14({
      roles: [
        {
          role: 'ecommerce',
          elected: { slug: 'shopify', name: 'Shopify' },
          source: 'elected',
          candidates: [{ slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' }],
        },
      ],
    });
    expect(screen.getByTestId('core-part-chosen')).toHaveTextContent(/Shopify does this/i);
    expect(screen.queryByTestId('core-part-inferred')).toBeNull();
  });

  it('points returns at its own switch, and the CRM at its own screen', async () => {
    // Two refusals, two destinations. One sentence for both would send
    // somebody to the CRM screen to change returns.
    await render14({
      roles: [
        { role: 'returns', candidates: [] },
        { role: 'crm', candidates: [] },
      ],
    });
    expect(screen.getByTestId('core-part-returns-elsewhere')).toHaveTextContent(/own switch/i);
    expect(screen.getByTestId('core-part-crm-elsewhere')).toHaveTextContent(/Integrations screen/i);
  });
});

describe('★ 14e — absent is not unset', () => {
  /*
   * The design draws a panel of write-back settings. There are none, and the
   * failure this block exists to prevent is a merchant reading that absence
   * as an omission: going to look for the screen that turns it on, when
   * there is no such screen because there is no such choice.
   */

  it('says the connected system decides, not that a field is blank', async () => {
    await render14();
    const lead = screen.getByTestId('core-writeback-source');
    // The load-bearing half: not a blank somebody forgot to fill in.
    expect(lead).toHaveTextContent(/not a blank/i);
    expect(lead).toHaveTextContent(/the system itself decides/i);
  });

  it('never phrases an absence as something not yet configured', async () => {
    /*
     * ★ THE ASSERTION THIS WHOLE BLOCK IS FOR.
     *
     * Every one of these is a decision the product has already made. The
     * vocabulary of an unfinished setup — "not configured", "coming soon",
     * "set this up" — would turn each of them into a promise.
     *
     * Asserted over the RENDERED block rather than the catalogue, because a
     * key can be edited and a sentence can arrive from somewhere else.
     */
    await render14();
    const block = screen.getByTestId('core-writeback');
    expect(block).not.toHaveTextContent(/not configured|unconfigured/i);
    expect(block).not.toHaveTextContent(/coming soon|not yet available/i);
    expect(block).not.toHaveTextContent(/set (this|it) up/i);
  });

  it('names all three things that are fixed, and says where each is fixed', async () => {
    await render14();
    expect(screen.getByTestId('core-writeback-per-rule')).toHaveTextContent(/no per-rule choice/i);
    expect(screen.getByTestId('core-writeback-one-board')).toHaveTextContent(
      /single Monday board/i,
    );
    // Identity resolution is in CODE — not a rule, not per-workspace.
    const identity = screen.getByTestId('core-writeback-identity');
    expect(identity).toHaveTextContent(/fixed in the product's code/i);
    expect(identity).toHaveTextContent(/same for everyone/i);
  });

  it('splits the language claim in two, because the platform does', async () => {
    /*
     * `post-chat-pipeline.service.ts` calls `resolveEffectiveLocale({ tenantId })`
     * with no userId, so the AI-written summary takes `Tenant.defaultLocale`.
     * `crm-adapter-resolver.ts` has no locale reference at all — field values
     * are the customer's data and nothing translates them.
     *
     * "Everything written back is in the workspace language" was the sentence
     * this screen nearly shipped. It is false for the half a merchant cares
     * most about, and the split is what tells them which half they control.
     */
    await render14();
    const language = screen.getByTestId('core-writeback-language');
    expect(language).toHaveTextContent(/in its own words/i);
    expect(language).toHaveTextContent(/workspace language/i);
    // And the half that is NOT translated, said explicitly.
    expect(language).toHaveTextContent(/customer's own data/i);
    expect(language).toHaveTextContent(/exactly as they are/i);
  });
});
