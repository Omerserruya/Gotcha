import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  messageSchema,
  systemEventOf,
  SYSTEM_EVENTS,
  type EscalationReason,
} from '@/api/contracts/inbox';
import en from '@/i18n/messages/en/inbox.json';
import he from '@/i18n/messages/he/inbox.json';

import { ConversationVerbs } from './ConversationVerbs';
import { MessageStream } from './MessageStream';

const ESCALATION_REASONS: readonly EscalationReason[] = [
  'daily_budget',
  'budget',
  'customer_asked',
  'ai_paused',
  'ai_inactive',
  'ai_failed',
  'message_limit',
];

/**
 * Screen 02's verbs, and the dividers they write.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING HERE PRESSES A VERB
 * ════════════════════════════════════════════════════════════════════════════
 * `claim` and `reassign` both end in `sendAutoGreeting`, which enqueues a
 * real outbound message on a real customer's channel. Dev sends real traffic.
 * The action module is mocked for this whole file and every function throws.
 *
 * What is tested is which controls exist in which state, and what the screen
 * says before anybody presses anything - which is the part that decides
 * whether a person sends a stranger a message by accident.
 */

const claimConversation = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call claimConversation');
  }),
);
/*
 * ★ Throws by default, like its neighbours. These verbs change a real
 *   conversation; a mock that silently resolves would let a test "pass" while
 *   exercising a call nobody meant to make. A test that WANTS the call
 *   overrides it.
 */
const closeConversation = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call closeConversation');
  }),
);
const returnToAi = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call returnToAi');
  }),
);
const transferConversation = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call transferConversation');
  }),
);
vi.mock('./conversation-actions', () => ({
  closeConversation,
  claimConversation,
  returnToAi,
  transferConversation,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox') =>
    createTranslator({ locale: 'en', messages: { inbox: en }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const colleagues = [
  { id: 'u2', name: 'Dana' },
  { id: 'u3', name: 'Yossi' },
];

const show = (over: Partial<Parameters<typeof ConversationVerbs>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox: en }}>
      <ConversationVerbs
        conversationId="c1"
        mine={false}
        handedOver={false}
        hasAiEmployee={true}
        greeting={null}
        colleagues={colleagues}
        resolved={false}
        {...over}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  claimConversation.mockClear();
  returnToAi.mockClear();
  transferConversation.mockClear();
});

describe('★★ the greeting warning, which is the reason this is not just a button', () => {
  it('★★ says the customer will be messaged when we know there is a greeting', () => {
    /*
     * THE FACT THE PREMISE READ TURNED UP. `claim()` ends in
     * `sendAutoGreeting`, so taking control enqueues a real outbound message
     * with the agent's name in it. An agent who does not know that is one
     * click from messaging a stranger, from a button labelled "take control".
     */
    show({ greeting: true });
    expect(screen.getByTestId('greeting-c1')).toHaveTextContent(
      /sends your workspace.s greeting to this customer/i,
    );
  });

  it('★★ hedges when we could not find out, rather than promising silence', () => {
    /*
     * `GET /settings/auto-greeting` is `requireRole("ADMIN")`, and most
     * people pressing this button are agents. Unknown is a third state: a
     * confident "nothing will be sent" built on a 403 is exactly the
     * collapse this product keeps finding.
     */
    show({ greeting: null });
    expect(screen.getByTestId('greeting-c1')).toHaveTextContent(
      /if your workspace has a greeting/i,
    );
    expect(screen.getByTestId('greeting-c1')).toHaveTextContent(/can.t check that from here/i);
  });

  it('★ says nothing at all when the workspace has no greeting', () => {
    // A warning about something that cannot happen is noise on every
    // conversation, and noise is how a real warning stops being read.
    show({ greeting: false });
    expect(screen.queryByTestId('greeting-c1')).toBeNull();
  });
});

describe('★★ which controls exist, and the one that never does', () => {
  it('★★ no claim button on a conversation that is already yours', () => {
    /*
     * The route allows a reclaim and it changes nothing - except that it
     * greets the customer a SECOND time: *"send on both claim and reclaim"*.
     * A button whose only effect is another "Hi, I'm Dana, taking over" is
     * worse than no button.
     */
    show({ mine: true, handedOver: true });
    expect(screen.queryByTestId('claim-c1')).toBeNull();
  });

  it('shows the claim button when it is not yours', () => {
    show({ mine: false });
    expect(screen.getByTestId('claim-c1')).toHaveTextContent(/take control/i);
  });

  it('★★ there is NO put-back-in-the-queue control, in any state', () => {
    /*
     * Omer ruled it out, and the platform agrees by accident: `release()`
     * clears `assignedAgentId` and leaves `isHandedOver` set, so a released
     * conversation has no human AND the AI is still latched off it. Nobody
     * is driving and no screen says so.
     */
    for (const state of [
      { mine: true, handedOver: true },
      { mine: false, handedOver: true },
      { mine: true, handedOver: false },
    ]) {
      const { unmount } = show(state);
      expect(screen.queryByText(/queue/i)).toBeNull();
      expect(screen.queryByText(/unassign|release|give up/i)).toBeNull();
      unmount();
    }
  });

  it('★ return-to-the-AI only once a human holds it', () => {
    // It clears a latch that is not set on a conversation the AI is already
    // answering - a control for a state the reader is already in.
    show({ handedOver: false });
    expect(screen.queryByTestId('return-c1')).toBeNull();
    show({ handedOver: true });
    expect(screen.getByTestId('return-c1')).toHaveTextContent(/return to the AI/i);
  });

  it('★★ transfer only on a conversation you hold, because the route refuses otherwise', () => {
    // Non-admins get 403 for a conversation that is not theirs, so drawing it
    // elsewhere would be a control that fails every single time.
    show({ mine: false });
    expect(screen.queryByTestId('transfer-c1')).toBeNull();
    show({ mine: true });
    expect(screen.getByTestId('transfer-c1')).toBeInTheDocument();
  });

  it('★ transfer stays disabled until a colleague is named', async () => {
    // "Transfer to nobody" is the unassign that is not allowed, arriving by
    // an empty select.
    show({ mine: true });
    expect(screen.getByTestId('transfer-c1')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('transfer-select-c1'), 'u2');
    expect(screen.getByTestId('transfer-c1')).not.toBeDisabled();
    // And still nothing has been called.
    expect(transferConversation).not.toHaveBeenCalled();
  });

  it('★ says there is nobody to hand back to, rather than hiding the control', () => {
    // The route answers 409 either way. A reader who can see the button and
    // the reason can act on the reason; a missing button explains nothing.
    show({ handedOver: true, hasAiEmployee: false });
    expect(screen.getByTestId('return-c1')).toBeInTheDocument();
    expect(screen.getByTestId('no-ai-c1')).toHaveTextContent(
      /no AI employee on this conversation/i,
    );
  });

  it('★★ an unknown AI binding offers the control and claims nothing', () => {
    // `null` is not `false`. The refusal is harmless and says why; a button
    // withheld on a guess is unexplainable.
    show({ handedOver: true, hasAiEmployee: null });
    expect(screen.getByTestId('return-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('no-ai-c1')).toBeNull();
  });
});

describe('★★ a colleague’s action is not a message from the customer', () => {
  const systemMessage = (systemEvent: string, data: Record<string, string> = {}) =>
    messageSchema.parse({
      id: `m-${systemEvent}`,
      direction: 'INBOUND',
      body: '',
      messageType: 'system',
      createdAt: '2026-09-26T09:00:00.000Z',
      metadata: { systemEvent, ...data },
    });

  const stream = async (messages: unknown[]) =>
    render(await MessageStream({ messages: messages as never, channel: 'WHATSAPP' }));

  it('★★ draws a divider, not an inbound bubble', async () => {
    /*
     * `createSystemMessage` writes `direction: "INBOUND"` and `body: ""`, so
     * without this every claim and transfer renders on the CUSTOMER's side of
     * the thread as a message they did not send. The direction is the
     * service's own convenience, not a statement about who acted.
     */
    await stream([systemMessage('agent_claimed', { agentName: 'Dana' })]);

    const divider = screen.getByTestId('system-m-agent_claimed');
    expect(divider).toHaveAttribute('data-event', 'agent_claimed');
    expect(divider).toHaveTextContent(/Dana took control/i);
    // And it is not the "we cannot show this" line, which is where an empty
    // system message landed before.
    expect(screen.queryByTestId('unknown-m-agent_claimed')).toBeNull();
  });

  it('★ Stop AI’s divider: the route writes no name, so none is said - and it is not "can’t show"', async () => {
    await stream([systemMessage('ai_stopped')]);
    const divider = screen.getByTestId('system-m-ai_stopped');
    expect(divider.textContent).toBe('AI stopped');
    expect(screen.queryByTestId('unknown-m-ai_stopped')).toBeNull();
  });

  it('★★ names both people on a transfer', async () => {
    await stream([
      systemMessage('agent_transferred', { fromAgentName: 'Dana', toAgentName: 'Yossi' }),
    ]);
    expect(screen.getByTestId('system-m-agent_transferred')).toHaveTextContent(
      /Dana transferred this to Yossi/i,
    );
  });

  it('★★ renders the department transfer this product never offers', async () => {
    /*
     * Omer ruled transfers go to a named person, so nothing here sends
     * `departmentId`. The platform still writes this divider when another
     * client does - and skipping it would leave an unexplained gap exactly
     * where somebody needs to know the conversation moved.
     */
    await stream([systemMessage('department_transferred')]);
    expect(screen.getByTestId('system-m-department_transferred')).toHaveTextContent(
      /transferred to another team/i,
    );
  });

  it('★★ an unknown system event is a neutral divider, never a customer bubble (Omer, 2026-10-11)', async () => {
    /*
     * It used to fall to "Something was sent here that we can't show yet" - an
     * empty bubble on the customer's side for something the platform did.
     * "System update" claims only what `messageType: "system"` proves.
     */
    await stream([systemMessage('agent_went_for_lunch')]);
    const divider = screen.getByTestId('system-m-agent_went_for_lunch');
    expect(divider).toHaveAttribute('data-event', 'other');
    expect(divider).toHaveTextContent(/^System update$/);
    expect(screen.queryByTestId('unknown-m-agent_went_for_lunch')).toBeNull();
  });

  it('★ a system message with no metadata at all is the same neutral divider', async () => {
    const bare = messageSchema.parse({
      id: 'm-bare',
      direction: 'INBOUND',
      body: '',
      messageType: ' System ',
      createdAt: '2026-09-26T09:00:00.000Z',
    });
    expect(systemEventOf(bare)).toBe('other');
    await stream([bare]);
    expect(screen.getByTestId('system-m-bare')).toHaveTextContent(/^System update$/);
    expect(screen.queryByTestId('unknown-m-bare')).toBeNull();
  });

  it('★★ a tagged text the customer received stays a message (the marketing confirmations)', () => {
    const confirmation = messageSchema.parse({
      id: 'm-optout',
      direction: 'OUTBOUND',
      body: 'You will not receive marketing messages.',
      messageType: 'text',
      createdAt: '2026-09-26T09:00:00.000Z',
      metadata: { systemEvent: 'marketing_opt_out_confirmation' },
    });
    expect(systemEventOf(confirmation)).toBeNull();
  });

  it('★★ the AI handing over says why in words, never the platform’s English summary', async () => {
    // The row Omer saw (conversation cmsbziuch0001cna5jixtd50q).
    await stream([
      systemMessage('ai_bot_escalation', {
        escalationCase: 'budget_exceeded:tenant_day',
        escalationSummary: 'Token budget exceeded (tenant_day): 1203/1000.',
      }),
    ]);
    const divider = screen.getByTestId('system-m-ai_bot_escalation');
    expect(divider).toHaveTextContent(
      /^GOTCHA handed the conversation to the team: the daily AI budget ran out$/,
    );
    expect(divider).not.toHaveTextContent(/Token budget/);
  });

  it.each([
    ['budget_exceeded:tenant_month', 'the AI budget ran out'],
    ['customer_requested_human', 'a person was asked for'],
    ['agent_paused', 'the AI employee is paused'],
    ['agent_inactive:PAUSED', 'the AI employee is not active'],
    ['ai_service_failure', 'the AI could not produce a reply'],
    ['hard_message_ceiling', 'the AI reached its message limit for this conversation'],
    ['autonomous_message_cap', 'the AI reached its message limit for this conversation'],
  ])('handover reason %s reads "%s"', async (escalationCase, words) => {
    await stream([systemMessage('ai_bot_escalation', { escalationCase })]);
    expect(screen.getByTestId('system-m-ai_bot_escalation')).toHaveTextContent(
      `GOTCHA handed the conversation to the team: ${words}`,
    );
  });

  it.each(['ai_decided', 'toString', 'the customer is angry'])(
    'a handover reason we have no words for (%s): the sentence alone',
    async (escalationCase) => {
      await stream([systemMessage('ai_bot_escalation', { escalationCase })]);
      expect(screen.getByTestId('system-m-ai_bot_escalation')).toHaveTextContent(
        /^GOTCHA handed the conversation to the team$/,
      );
    },
  );

  it.each([
    ['flow_ended_handoff', 'The automation ended and handed the conversation to the team'],
    ['visitor_requested_human', 'The visitor asked for a person in the website chat'],
    ['auto_closed', 'Closed automatically after no activity'],
    [
      'whatsapp_app_takeover',
      'Someone replied from the WhatsApp Business app, so GOTCHA stopped replying',
    ],
    ['continued_on_whatsapp', 'The conversation continues on WhatsApp'],
    ['continued_from_website', 'Continued from the website chat'],
    ['approval_execution_failed', 'An approved action failed'],
  ])('%s is a divider that says "%s"', async (event, words) => {
    await stream([systemMessage(event)]);
    const divider = screen.getByTestId(`system-m-${event}`);
    expect(divider).toHaveAttribute('data-event', event);
    expect(divider).toHaveTextContent(new RegExp(`^${words}$`));
  });
});

describe('★★ both languages say all of it', () => {
  it('★★ every sentence exists in en and he', () => {
    const at = (messages: unknown, path: string) =>
      path
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);

    const keys = [
      'verbs.claim',
      'verbs.returnToAi',
      'verbs.transferTo',
      'verbs.transferPick',
      'verbs.transfer',
      'verbs.greetingSends',
      'verbs.greetingMaybe',
      'verbs.noAiEmployee',
      'verbs.problem.already_claimed',
      'verbs.problem.no_ai_employee',
      'verbs.problem.not_yours',
      'verbs.problem.not_found',
      'verbs.problem.failed',
      ...SYSTEM_EVENTS.map((event) => `stream.system.${event}`),
      'stream.system.other',
      'stream.system.ai_bot_escalation_because',
      ...ESCALATION_REASONS.map((reason) => `stream.system.reason.${reason}`),
    ];

    for (const key of keys) {
      for (const [locale, messages] of [
        ['en', en],
        ['he', he],
      ] as const) {
        const value = at(messages, key);
        expect(typeof value, `${locale}:${key}`).toBe('string');
        expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('★ the renames Omer asked for are the words that ship', () => {
    // "Pause the AI here" → take control / קבל שליטה.
    expect(en.verbs.claim).toBe('Take control');
    expect(he.verbs.claim).toBe('קבל שליטה');
    // "Put back in the queue" → return to the AI, and no queue anywhere.
    expect(en.verbs.returnToAi).toBe('Return to the AI');
    expect(JSON.stringify(en.verbs)).not.toMatch(/queue/i);
    expect(JSON.stringify(en.verbs)).not.toMatch(/pause/i);
  });
});

describe('⚠⚠ Resolve - 02’s third button, and the route existed all along', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE DESIGN DRAWS THREE: ASSIGN · PAUSE AI · RESOLVE. WE DREW ONE.
   * ════════════════════════════════════════════════════════════════════════
   * `closeConversation` posts to `/conversations/{id}/close`, which the
   * platform has always had - it was missing from THIS app, not from the API.
   */
  it('★★ is offered on a live conversation', async () => {
    show({ resolved: false });
    expect(screen.getByTestId('resolve-c1')).toBeInTheDocument();
  });

  it('⚠⚠ and NOT on one already closed', async () => {
    /*
     * ★ The route accepts it as a no-op. A button whose only effect is
     *   nothing is how a screen teaches somebody that its controls are
     *   decorative - the same reason `claim` is not drawn on a conversation
     *   that is already yours, where re-claiming would re-greet the customer.
     */
    show({ resolved: true });
    expect(screen.queryByTestId('resolve-c1')).toBeNull();
  });

  it('★ calls close, not claim', async () => {
    closeConversation.mockResolvedValueOnce({ ok: true } as never);
    show({ resolved: false });
    await userEvent.click(screen.getByTestId('resolve-c1'));
    expect(closeConversation).toHaveBeenCalledWith('c1');
    expect(claimConversation).not.toHaveBeenCalled();
  });
});

describe('★ 02 fills ONE header button, and it is Resolve', () => {
  it('⚠ "Take control" is outlined like its siblings, not filled like Resolve', () => {
    /*
     * A surviving mutation filled it with nothing going red. 02 draws Assign
     * and Pause AI outlined and only Resolve in #121212 - two filled buttons
     * side by side would make the screen's one decisive action ambiguous.
     */
    show({ mine: false, handedOver: true, resolved: false });
    const claim = screen.getByTestId('claim-c1');
    expect(claim.className).toBe(screen.getByTestId('return-c1').className);
    expect(claim.className).not.toBe(screen.getByTestId('resolve-c1').className);
  });
});
