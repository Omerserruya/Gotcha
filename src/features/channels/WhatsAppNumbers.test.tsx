import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { numbersResponseSchema } from '@/api/contracts/whatsapp-numbers';
import messages from '@/i18n/messages/en/channels.json';

import { WhatsAppNumbers } from './WhatsAppNumbers';

/**
 * Screen 13, where almost nothing is capturable.
 *
 * `whatsapp_numbers` has ZERO rows on the whole database and
 * `whatsapp_number_events` has zero too, so a capture can only ever
 * photograph the unprofiled card. Every state that matters — outbound
 * blocked, a repair we can run, a fix that belongs to Meta, the registration
 * case — exists only here.
 *
 * An absence assertion on the live screen would pass against a blank page, so
 * the absences are asserted HERE, where the thing could have appeared.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
/* The switch is a client component with its own test. */
vi.mock('./ModeSwitch', () => ({
  ModeSwitch: ({ channelAccountId, current }: { channelAccountId: string; current: string }) => (
    <span data-testid={`mode-switch-${channelAccountId}`} data-current={current} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels: messages }, namespace }),
  getLocale: async () => 'en',
}));

const number = (health: Record<string, unknown> = {}) => ({
  id: 'n1',
  phoneNumber: '+972 50 000 0000',
  name: 'Support',
  state: 'CONNECTED',
  health: { state: 'CONNECTED', receiving: true, sending: true, ...health },
});

const renderNumbers = async (payload: Record<string, unknown>) =>
  render(await WhatsAppNumbers({ numbers: numbersResponseSchema.parse(payload) }));

describe('★ a number receiving while Meta blocks its replies', () => {
  it('is inbound_only, and never reads as not working', async () => {
    /*
     * The bug the platform's comment records: this exact number "reported as
     * '0 working, 1 needs attention' to a customer whose inbox was filling
     * up". `ready` is false and the inbox is filling.
     */
    await renderNumbers({
      data: [
        number({
          ready: false,
          receiving: true,
          sending: false,
          state: 'DEGRADED',
        }),
      ],
    });

    expect(screen.getByTestId('whatsapp-number')).toHaveAttribute('data-delivery', 'inbound_only');
    expect(screen.getByTestId('whatsapp-delivery')).toHaveTextContent(
      /receiving, but not sending/i,
    );
  });

  it('says the half that still works, which is the half the inbox depends on', async () => {
    await renderNumbers({
      data: [number({ ready: false, receiving: true, sending: false })],
    });
    const detail = screen.getByTestId('whatsapp-delivery-detail');
    expect(detail).toHaveTextContent(/still arriving/i);
    expect(detail).toHaveTextContent(/replies are the part that is blocked/i);
  });

  it('distinguishes it from a number that is genuinely down', async () => {
    await renderNumbers({ data: [number({ receiving: false, sending: false, ready: false })] });
    expect(screen.getByTestId('whatsapp-number')).toHaveAttribute('data-delivery', 'down');
  });

  it('calls a healthy number working', async () => {
    await renderNumbers({ data: [number()] });
    expect(screen.getByTestId('whatsapp-number')).toHaveAttribute('data-delivery', 'working');
  });
});

describe('what stops messages today is separated from what is worth knowing', () => {
  const checks = [
    { id: 'REGISTRATION', label: 'Registration', status: 'FAIL', blocking: true },
    { id: 'QUALITY', label: 'Quality rating', status: 'WARN', blocking: false },
  ];

  it('renders both sections, not one flat list', async () => {
    /*
     * Without the split "an unregistered number sat in the same flat list as
     * a SIP calling notice, and the customer could not tell which one was the
     * reason nothing worked."
     */
    await renderNumbers({ data: [number({ checks, receiving: true, sending: false })] });
    expect(screen.getByTestId('whatsapp-blocking')).toHaveTextContent(/Registration/);
    expect(screen.getByTestId('whatsapp-advisory')).toHaveTextContent(/Quality rating/);
    // The advisory one is not discarded, and not promoted either.
    expect(screen.getByTestId('whatsapp-blocking')).not.toHaveTextContent(/Quality rating/);
  });

  it('renders Meta’s remediation text verbatim', async () => {
    const verbatim = 'Finish the OTP authentication for this phone number.';
    await renderNumbers({
      data: [
        number({
          checks: [
            {
              id: 'REGISTRATION',
              label: 'Registration',
              status: 'FAIL',
              blocking: true,
              metaSolution: verbatim,
              metaErrorCode: 141000,
            },
          ],
        }),
      ],
    });
    // Never rewritten: a paraphrase of a platform's fix instructions is a new
    // instruction that nobody tested.
    expect(screen.getByTestId('whatsapp-meta-solution')).toHaveTextContent(verbatim);
  });
});

describe('★ three places a problem can be fixed, and no button that cannot work', () => {
  it('offers the registration fix as something the customer does HERE', async () => {
    await renderNumbers({
      data: [
        number({
          receiving: true,
          sending: false,
          needsRegistration: true,
          availableRepairs: [],
        }),
      ],
    });
    const here = screen.getByTestId('whatsapp-register');
    expect(here).toHaveTextContent(/you can fix this here/i);
    expect(here).toHaveTextContent(/two-step PIN/i);
  });

  it('names Meta-only problems WITHOUT offering a repair for them', async () => {
    /*
     * "so the UI never offers a button that cannot work; offering one and
     * having it fail is worse than saying plainly that this one is theirs."
     */
    await renderNumbers({
      data: [
        number({
          receiving: false,
          sending: false,
          availableRepairs: [],
          needsRegistration: false,
          customerActions: [
            { id: 'VERIFICATION', label: 'Business verification', status: 'FAIL', blocking: true },
          ],
        }),
      ],
    });
    const theirs = screen.getByTestId('whatsapp-customer-actions');
    expect(theirs).toHaveTextContent(/fix this in Meta/i);
    expect(theirs).toHaveTextContent(/cannot be resolved from GOTCHA/i);
    // No repair list, and no registration offer, for a number with neither.
    expect(screen.queryByTestId('whatsapp-repairs')).toBeNull();
    expect(screen.queryByTestId('whatsapp-register')).toBeNull();
  });

  it('lists only the repairs we can genuinely run', async () => {
    await renderNumbers({
      data: [number({ availableRepairs: ['RESUBSCRIBE_WEBHOOKS', 'REFRESH_STATUS'] })],
    });
    expect(screen.getAllByTestId('whatsapp-repair')).toHaveLength(2);
  });

  it('renders no actions area at all when there is nothing to do', async () => {
    // An empty actions area reads as a section that failed to load.
    await renderNumbers({ data: [number()] });
    expect(screen.queryByTestId('whatsapp-repairs')).toBeNull();
    expect(screen.queryByTestId('whatsapp-register')).toBeNull();
    expect(screen.queryByTestId('whatsapp-customer-actions')).toBeNull();
  });
});

describe('★ templates paused — the state Omer asked to be warned about', () => {
  const templateBlock = (over = {}) => ({
    entities: [
      {
        entity_type: 'MESSAGE_TEMPLATE',
        can_send_message: 'BLOCKED',
        errors: [
          {
            error_code: 131049,
            error_description: 'This WhatsApp Business Account has no payment method attached.',
            possible_solution: 'Add a payment method in Meta Business Manager.',
          },
        ],
      },
    ],
    ...over,
  });

  it('warns above the list when Meta has blocked templates', async () => {
    await renderNumbers({
      data: [number({ receiving: true, sending: true, healthSnapshot: templateBlock() })],
    });
    const banner = screen.getByTestId('templates-paused');
    expect(banner).toHaveTextContent(/templates are paused/i);
    expect(banner).toHaveTextContent(/reminders, cart recovery or campaigns/i);
  });

  it('★ says replies still go out, so it does not read as "WhatsApp is down"', async () => {
    /*
     * The design's second sentence, and the whole reason the banner is not an
     * error. Templates paused is `sending` blocked for ONE entity while
     * ordinary replies inside the 24-hour window keep working.
     */
    await renderNumbers({
      data: [number({ receiving: true, healthSnapshot: templateBlock() })],
    });
    expect(screen.getByTestId('templates-paused-replies')).toHaveTextContent(/last 24 hours/i);
  });

  it('does NOT promise replies still flow for a number that is not receiving', async () => {
    // Gated on the fact rather than stated as a general truth about WhatsApp.
    await renderNumbers({
      data: [number({ receiving: false, sending: false, healthSnapshot: templateBlock() })],
    });
    expect(screen.getByTestId('templates-paused')).toBeInTheDocument();
    expect(screen.queryByTestId('templates-paused-replies')).toBeNull();
  });

  it("★ quotes Meta's reason instead of asserting the cause itself", async () => {
    /*
     * The design's copy says "has no payment method". That is ONE cause —
     * quality ratings and policy violations pause templates too. We report
     * the block, which we know, and quote Meta for the cause, which they know.
     */
    await renderNumbers({
      data: [number({ receiving: true, healthSnapshot: templateBlock() })],
    });
    expect(screen.getByTestId('templates-paused-reason')).toHaveTextContent(
      /no payment method attached/i,
    );
    expect(screen.getByTestId('templates-paused-solution')).toHaveTextContent(
      /Meta Business Manager/i,
    );
  });

  it('says so when Meta gave no reason, rather than inventing one', async () => {
    await renderNumbers({
      data: [
        number({
          receiving: true,
          healthSnapshot: {
            entities: [
              { entity_type: 'MESSAGE_TEMPLATE', can_send_message: 'BLOCKED', errors: [] },
            ],
          },
        }),
      ],
    });
    expect(screen.getByTestId('templates-paused-reason')).toHaveTextContent(/did not say why/i);
  });

  it('badges the number without overwriting its delivery verdict', async () => {
    /*
     * A number can be sending and receiving ordinary replies AND have its
     * templates paused. The badge sits beside the verdict, never instead of
     * it — the same rule as `ready` not replacing receiving/sending.
     */
    await renderNumbers({
      data: [number({ receiving: true, sending: true, healthSnapshot: templateBlock() })],
    });
    expect(screen.getByTestId('whatsapp-number')).toHaveAttribute('data-delivery', 'working');
    expect(screen.getByTestId('whatsapp-templates-badge')).toHaveTextContent(/templates paused/i);
  });

  it('does not warn when only a PHONE_NUMBER entity is blocked', async () => {
    // `healthEntitiesToChecks` flattens every non-registration block to
    // `id: "MESSAGING"`, so matching on the check would fire here too.
    await renderNumbers({
      data: [
        number({
          receiving: true,
          sending: false,
          healthSnapshot: {
            entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'BLOCKED', errors: [] }],
          },
        }),
      ],
    });
    expect(screen.queryByTestId('templates-paused')).toBeNull();
    expect(screen.queryByTestId('whatsapp-templates-badge')).toBeNull();
  });

  it('does not warn when templates are merely LIMITED', async () => {
    await renderNumbers({
      data: [
        number({
          receiving: true,
          healthSnapshot: {
            entities: [
              { entity_type: 'MESSAGE_TEMPLATE', can_send_message: 'LIMITED', errors: [] },
            ],
          },
        }),
      ],
    });
    expect(screen.queryByTestId('templates-paused')).toBeNull();
  });

  it('says nothing for a healthy number', async () => {
    await renderNumbers({ data: [number()] });
    expect(screen.queryByTestId('templates-paused')).toBeNull();
  });
});

describe('the card this tenant actually has', () => {
  it('says it is connected AND that nothing is known, without implying either verdict', async () => {
    await renderNumbers({
      data: [],
      unprofiled: [
        {
          channelAccountId: 'ca1',
          phoneNumberId: '1010938148762991',
          name: 'Demo WhatsApp',
          connectionStatus: 'CONNECTED',
          note: 'Connected before per-number health was available.',
        },
      ],
    });
    const card = screen.getByTestId('whatsapp-unprofiled');
    // S2: 02's card — the state as a grey chip, its explanation on the chip.
    const chip = screen.getByText('No health data');
    expect(card).toContainElement(chip);
    expect(chip).toHaveAttribute('title', expect.stringMatching(/connected and working/i));
    // The raw value is never printed.
    expect(card).not.toHaveTextContent('CONNECTED');
    // No health verdict, because there is no health.
    expect(screen.queryByTestId('whatsapp-delivery-detail')).toBeNull();
    // And no repairs: every repair verb addresses a record that does not exist.
    expect(screen.queryByTestId('whatsapp-repairs')).toBeNull();
  });

  it('is rendered rather than hidden, so it does not read as a missing number', async () => {
    // "a number the customer can see in their inbox but not on this page
    // reads as a bug."
    await renderNumbers({
      data: [],
      unprofiled: [{ channelAccountId: 'ca1', phoneNumberId: 'p1', connectionStatus: 'CONNECTED' }],
    });
    expect(screen.queryByTestId('whatsapp-empty')).toBeNull();
    expect(screen.getByTestId('whatsapp-numbers')).toBeInTheDocument();
  });
});

describe('a failed read is not an empty workspace', () => {
  it('says so explicitly', async () => {
    render(await WhatsAppNumbers({ numbers: null }));
    const un = screen.getByTestId('whatsapp-unavailable');
    expect(un).toHaveTextContent(/could not load/i);
    // The sentence that stops it being read as "you have none".
    expect(un).toHaveTextContent(/does not mean you have none/i);
  });

  it('says the workspace is empty only when BOTH arrays are', async () => {
    await renderNumbers({ data: [], unprofiled: [] });
    expect(screen.getByTestId('whatsapp-empty')).toHaveTextContent(
      /no whatsapp numbers are connected/i,
    );
  });
});

describe('★ 13b — what is configured on a number, in 02’s rows', () => {
  it('AI mode comes from the channel; the rest are "—" in their shape', async () => {
    render(
      await WhatsAppNumbers({
        numbers: {
          data: [],
          unprofiled: [
            {
              channelAccountId: 'ca1',
              phoneNumberId: 'p1',
              name: 'Demo WhatsApp',
              connectionStatus: 'CONNECTED',
            },
          ],
        } as never,
        responseModes: { ca1: 'AI_AUTO_REPLY' },
      }),
    );
    // 02's two segments, live, on the account, set to what it is now.
    expect(screen.getByTestId('mode-switch-ca1')).toHaveAttribute('data-current', 'AI_AUTO_REPLY');
    expect(screen.getByTestId('whatsapp-unprofiled')).toHaveTextContent(/Answered by—/);
  });
});

describe('★ 13c starts from 13b: "Add another number" — Meta’s launcher', () => {
  it('at the foot of the list, and under the empty state', async () => {
    const { unmount } = await renderNumbers({ data: [number()] });
    const add = screen.getByTestId('whatsapp-add-number');
    expect(add).toHaveTextContent('+ Add another number');
    // Not set up on the server: drawn, with why.
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add.getAttribute('title')).toMatch(/isn't set up/);
    unmount();
    await renderNumbers({ data: [] });
    expect(screen.getByTestId('whatsapp-empty')).toBeInTheDocument();
    expect(screen.getByTestId('whatsapp-add-number')).toBeInTheDocument();
  });
});

describe('★★ 13c — "Add another number" opens the Connect WhatsApp sheet, not Meta', () => {
  it('set up: a link to the sheet — Meta opens only from the sheet’s Continue', async () => {
    render(
      await WhatsAppNumbers({
        numbers: numbersResponseSchema.parse({ data: [number()] }),
        connectable: true,
      }),
    );
    const add = screen.getByTestId('whatsapp-add-number');
    expect(add.tagName).toBe('A');
    expect(add).toHaveAttribute('href', '/settings/channels?panel=whatsapp&view=connect');
  });
});
