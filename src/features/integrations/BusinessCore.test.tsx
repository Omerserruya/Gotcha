import { render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { businessCoreSchema } from '@/api/contracts/business-core';
import messages from '@/i18n/messages/en/business-core.json';

import { BusinessCore } from './BusinessCore';

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
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
    // S2: on the control it explains, not a sentence beside it.
    expect(
      screen.getByTestId('core-use-case').querySelector('[role="radiogroup"]'),
    ).toHaveAttribute('title', expect.stringMatching(/never asked about shipping or returns/i));
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

  it('names what cannot be configured, with Monday as an EXAMPLE and not the subject', async () => {
    /*
     * ★ Omer has no Monday connected. A page written as a Monday page with a
     * caveat asks somebody to reason about a system they have never seen —
     * which is exactly why the design's two-board question could not be
     * answered when it was put to him.
     *
     * So Monday is named as an example and named as absent, and the rule is
     * stated about connected systems generally.
     */
    await render14();
    expect(screen.getByTestId('core-writeback-per-rule')).toHaveTextContent(/no per-rule choice/i);
    const board = screen.getByTestId('core-writeback-one-board');
    expect(board).toHaveTextContent(/boards or lists/i);
    expect(board).toHaveTextContent(/isn't connected here/i);
  });

  it('★ says the CRM default nobody chose — with the condition that makes it true', async () => {
    /*
     * `crm-adapter-resolver.ts:146-191`. `useAsCrm` absent means a connected
     * Shopify is the DEFAULT CRM — but only when no dedicated CRM-category
     * integration is connected, because step 2 finds that one first.
     *
     * Stated unconditionally it is FALSE for a tenant with HubSpot connected,
     * and would tell them their customer records live somewhere they do not.
     * The condition is the difference between a useful sentence and a
     * confidently wrong one.
     */
    await render14();
    const crm = screen.getByTestId('core-writeback-crm-default');
    expect(crm).toHaveTextContent(/nobody chose that/i);
    expect(crm).toHaveTextContent(/no dedicated CRM is connected/i);
  });

  it('★ says a failing system STAYS the source of truth, and why that is deliberate', async () => {
    /*
     * `crm-adapter-resolver.ts:158,178` both match
     * `status: { in: ["CONNECTED", "ERROR"] }`. This tenant's Shopify is in
     * ERROR with a failed token refresh and is still where its customer
     * records resolve.
     *
     * ★ FRAMED AS REASSURANCE, WHICH IS WHAT IT IS. A merchant watching a
     * failing Shopify would reasonably assume their records had quietly moved
     * or stopped being written. They have not, and no other page can tell
     * them.
     *
     * But the cost is stated too: the system being written to is the one that
     * is down. Reassurance that omits that would be the calm wrong value in
     * the place this whole page exists to avoid it.
     */
    await render14();
    const still = screen.getByTestId('core-writeback-still-source');
    expect(still).toHaveTextContent(/stays the source of truth/i);
    expect(still).toHaveTextContent(/doesn't quietly move your customer records/i);
    // Deliberate, not an oversight — and the reason, so it reads as a design.
    expect(still).toHaveTextContent(/deliberate/i);
    // ★ The cost, said out loud.
    expect(still).toHaveTextContent(/the one that's currently down/i);
  });

  it('★★ identity: the ONE-match case is a write, not a lookup', async () => {
    /*
     * `crm-identity.service.ts` owns a 0/1/2+ flow. "First match wins, new
     * contact if none match" loses the half that matters: on exactly one
     * match GOTCHA ENRICHES the record with missing strong identifiers —
     * phone, email, PSID, IGSID, username.
     *
     * That is a write to a customer's record nobody asked for, and it is the
     * sentence a merchant would most want before it happens.
     */
    await render14();
    expect(screen.getByTestId('core-identity-none')).toHaveTextContent(/new record is created/i);

    const one = screen.getByTestId('core-identity-one');
    expect(one).toHaveTextContent(/fills in what's missing/i);
    // Said plainly, because "resolves identity" would hide it entirely.
    expect(one).toHaveTextContent(/writes to the record, it doesn't just read it/i);

    // And 2+ is approval-gated because a wrong merge is irreversible.
    const many = screen.getByTestId('core-identity-many');
    expect(many).toHaveTextContent(/Approvals queue/i);
    expect(many).toHaveTextContent(/cannot be undone/i);
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

describe('★ 14 — a part is 02’s row: what it is, who plays it, its state', () => {
  it('★ the state sentence rides on the chip, and the row shows the purpose, not prose', async () => {
    await render14();
    const chip = screen.getByTestId('core-chip-ecommerce');
    expect(chip.getAttribute('title')).toBeTruthy();
    expect(screen.getByTestId('core-part-ecommerce')).toHaveTextContent('the catalogue and orders');
  });

  it('★ the footer says where connecting lives — Studio · Integrations', async () => {
    await render14();
    expect(screen.getByRole('link', { name: 'Studio · Integrations' })).toHaveAttribute(
      'href',
      '/studio/capabilities',
    );
  });
});

describe('★ 14 corrections (measurement of 204d715)', () => {
  it('a broken system is named in its tile; "—" only where there is no system', async () => {
    await render14();
    expect(screen.getByTestId('core-system-ecommerce')).toHaveTextContent(/^Shopify$/);
    expect(screen.getByTestId('core-chip-ecommerce')).toHaveTextContent('Needs fixing');
    expect(within(screen.getByTestId('core-part-payments')).getByText('—')).toBeInTheDocument();
  });
});
