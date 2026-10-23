import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { employeeTestSchema, goLiveSchema } from '@/api/contracts/onboarding-v2';
import channelsEn from '@/i18n/messages/en/channels.json';
import onboardingEn from '@/i18n/messages/en/onboarding.json';
import channelsHe from '@/i18n/messages/he/channels.json';
import onboardingHe from '@/i18n/messages/he/onboarding.json';

/** Step 4's end. Mocked: nothing goes live, nothing is asked, nothing is saved. */
const { actions, steps, router } = vi.hoisted(() => ({
  actions: { goLive: vi.fn(), askEmployee: vi.fn() },
  steps: { saveStep: vi.fn() },
  router: { push: vi.fn() },
}));
vi.mock('./live-actions', () => actions);
vi.mock('./step-actions', () => steps);
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => router,
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { GoLiveStep } from './GoLiveStep';

const live = (over: object = {}) =>
  goLiveSchema.parse({
    employee: { id: 'a1', name: 'Noa', status: 'ACTIVE' },
    channels: [
      { id: 'c1', type: 'WHATSAPP', displayName: null, routed: true, reach: 'live' },
      {
        id: 'c2',
        type: 'WEBCHAT',
        displayName: 'avivco.il',
        routed: true,
        reach: 'waiting_for_install',
      },
    ],
    tools: { platform: 'shopify', granted: ['shopify.get_order'] },
    warnings: [],
    test: { suggestedOrderQuestion: 'Where is my order #1001?' },
    ...over,
  });
const answer = (over: object = {}) =>
  employeeTestSchema.parse({
    answer: 'Your order shipped yesterday.',
    toolsUsed: [{ name: 'shopify.get_order', ok: true }],
    sources: [],
    usedRealOrder: true,
    orderNumber: '1001',
    platform: 'shopify',
    ...over,
  });

const show = (props: Partial<Parameters<typeof GoLiveStep>[0]> = {}, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{
        onboarding: he ? onboardingHe : onboardingEn,
        channels: he ? channelsHe : channelsEn,
      }}
    >
      <GoLiveStep reach="Web chat and WhatsApp" current={null} {...props} />
    </NextIntlClientProvider>,
  );

/** Press, and let the answer land. */
const press = async () => {
  await act(async () => fireEvent.click(screen.getByTestId('go-live-press')));
};

beforeEach(() => {
  actions.goLive.mockReset();
  actions.askEmployee.mockReset();
  steps.saveStep.mockReset();
  router.push.mockReset();
});

describe('★★ before the press: what happens, said plainly', () => {
  it('★★ where it will answer: only the channels a customer can write on now; the press sends nothing', () => {
    show();
    expect(screen.getByTestId('go-live-what')).toHaveTextContent(
      /^Your AI employee answers customers on Web chat and WhatsApp from now on\.$/,
    );
    expect(screen.getByTestId('go-live')).toHaveTextContent('Pressing sends nothing to anyone.');
    expect(screen.getByTestId('go-live-press')).toHaveTextContent(/^Go live$/);
  });

  it('★ the name typed is the name said', () => {
    show();
    fireEvent.change(screen.getByLabelText("Your employee's name"), { target: { value: 'Dana' } });
    expect(screen.getByTestId('go-live-what')).toHaveTextContent(/^Dana answers customers/);
  });

  it('★★ no reachable channel: live, but answering nowhere yet - the button says so, and the way to a channel', () => {
    show({ reach: '' });
    expect(screen.getByTestId('go-live-what')).toHaveTextContent(
      "Going live, but there's no channel customers can write on yet",
    );
    expect(screen.getByTestId('go-live-press')).toHaveTextContent(/^Go live, with no channel yet$/);
    expect(screen.getByTestId('go-live-to-channels')).toHaveAttribute(
      'href',
      '/onboarding/channels',
    );
  });

  it('★ channels unread: said as unknown, never "nowhere"', () => {
    show({ reach: null });
    expect(screen.getByTestId('go-live-what')).toHaveTextContent("We couldn't read your channels");
    expect(screen.getByTestId('go-live-press')).toHaveTextContent(/^Go live$/);
    expect(screen.queryByTestId('go-live-to-channels')).toBeNull();
  });

  it('★★ Hebrew: no gendered verb after the name (its gender is not known); the server’s phrase as is', () => {
    show({ reach: 'בצ׳אט באתר ובוואטסאפ' }, true);
    expect(screen.getByTestId('go-live-what')).toHaveTextContent(
      /^מעכשיו העובד הדיגיטלי שלכם על המשמרת: לקוחות שכותבים בצ׳אט באתר ובוואטסאפ יקבלו תשובה\.$/,
    );
  });

  it('preview: no press, and no test', () => {
    show({ preview: true });
    expect(screen.queryByTestId('go-live-press')).toBeNull();
    expect(screen.queryByTestId('go-live-test')).toBeNull();
  });
});

describe('★★ the press, and what went live', () => {
  it('★★ the name is sent; each channel says whether it answers there NOW or waits for install', async () => {
    actions.goLive.mockResolvedValue({ ok: true, live: live() });
    show();
    fireEvent.change(screen.getByLabelText("Your employee's name"), { target: { value: ' Noa ' } });
    await press();
    expect(actions.goLive).toHaveBeenCalledWith(' Noa ');
    expect(screen.getByTestId('go-live-done')).toHaveTextContent('Noa is live.');
    expect(screen.getByTestId('go-live-channel-c1')).toHaveTextContent(
      /^WhatsApp: Answering here$/,
    );
    expect(screen.getByTestId('go-live-channel-c2')).toHaveTextContent(
      /^Web chat: Waiting for install$/,
    );
    expect(screen.queryByTestId('go-live-press')).toBeNull();
  });

  it('★★ order tools are said as looking orders up, never more', async () => {
    actions.goLive.mockResolvedValue({ ok: true, live: live() });
    show();
    await press();
    expect(screen.getByTestId('go-live-orders')).toHaveTextContent(
      /^Noa can look up orders in Shopify\.$/,
    );
    expect(screen.getByTestId('go-live')).not.toHaveTextContent(/refund|edit|cancel|change/i);
  });

  it('★ a store connected but no order tool granted: no orders line, never claimed', async () => {
    actions.goLive.mockResolvedValue({
      ok: true,
      live: live({ tools: { platform: 'shopify', granted: [] } }),
    });
    show();
    await press();
    expect(screen.queryByTestId('go-live-orders')).toBeNull();
  });

  it('no tool granted: no orders line', async () => {
    actions.goLive.mockResolvedValue({
      ok: true,
      live: live({ tools: { platform: null, granted: [] }, warnings: ['no_platform_connected'] }),
    });
    show();
    await press();
    expect(screen.queryByTestId('go-live-orders')).toBeNull();
    expect(screen.getByTestId('go-live-warning-no_platform_connected')).toHaveTextContent(
      "No store is connected, so there's no access to orders yet.",
    );
  });

  it('★ each warning Backend names is said; one it does not is not guessed at', async () => {
    actions.goLive.mockResolvedValue({
      ok: true,
      live: live({
        warnings: [
          'no_reachable_channel',
          'playbook_customized',
          'employee_customized',
          'no_channels',
          'cosmic_rays',
        ],
      }),
    });
    show();
    await press();
    for (const warning of [
      'no_reachable_channel',
      'playbook_customized',
      'employee_customized',
      'no_channels',
    ]) {
      expect(screen.getByTestId(`go-live-warning-${warning}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('go-live-warning-cosmic_rays')).toBeNull();
  });

  it('★★ refused: said, nothing went live, the press stays', async () => {
    actions.goLive.mockResolvedValue({
      ok: false,
      reason: 'awaiting_payment',
      payAt: '/en/checkout/payment-required?ref=r1',
    });
    show();
    await press();
    expect(screen.getByTestId('go-live-refused')).toHaveTextContent(
      'The account opens after the first payment. Nothing went live.',
    );
    // The way out, right beside it.
    expect(screen.getByTestId('go-live-pay')).toHaveAttribute(
      'href',
      '/en/checkout/payment-required?ref=r1',
    );
    expect(screen.getByTestId('go-live-press')).toBeInTheDocument();
    expect(screen.queryByTestId('go-live-test')).toBeNull();
  });

  it('a refusal other than payment offers no payment link', async () => {
    actions.goLive.mockResolvedValue({ ok: false, reason: 'suspended' });
    show();
    await press();
    expect(screen.queryByTestId('go-live-pay')).toBeNull();
  });

  it('★ a press that rejects reads as failed, never hangs', async () => {
    actions.goLive.mockRejectedValue(new Error('Failed to fetch'));
    show();
    await press();
    expect(screen.getByTestId('go-live-refused')).toHaveTextContent("We couldn't go live");
  });

  it('★★ already live (GET /step): "<name> is already live", its name in the field, pressing again updates it; the test is there', () => {
    show({ current: { name: 'Dana' } });
    expect(screen.getByTestId('go-live-again')).toHaveTextContent(/^Dana is already live\./);
    // The current name, never an empty field that reads as "we'll choose a new one".
    expect(screen.getByLabelText("Your employee's name")).toHaveValue('Dana');
    expect(screen.getByTestId('go-live')).toHaveTextContent('Changing it here renames it.');
    expect(screen.getByTestId('go-live')).not.toHaveTextContent("we'll choose one");
    expect(screen.getByTestId('go-live-press')).toHaveTextContent(/^Update the employee$/);
    expect(screen.getByTestId('go-live-test')).toHaveTextContent('Try Dana');
  });

  it('before go-live: an empty name field, and "we\'ll choose one"', () => {
    show();
    expect(screen.getByLabelText("Your employee's name")).toHaveValue('');
    expect(screen.getByTestId('go-live')).toHaveTextContent("Leave it empty and we'll choose one.");
    expect(screen.queryByTestId('go-live-again')).toBeNull();
  });
});

describe('★★ the test: one question, in a sandbox', () => {
  const goneLive = async () => {
    actions.goLive.mockResolvedValue({ ok: true, live: live() });
    show();
    await press();
  };
  const ask = async () => {
    await act(async () => fireEvent.submit(screen.getByTestId('go-live-test')));
  };

  it('★★ starts from the real-order question; nothing is sent, said', async () => {
    await goneLive();
    expect(screen.getByLabelText('Question')).toHaveValue('Where is my order #1001?');
    expect(screen.getByTestId('go-live-test')).toHaveTextContent('nothing is sent to anyone');
  });

  it('★★ answered from a real order: which order, in which store', async () => {
    actions.askEmployee.mockResolvedValue({ ok: true, test: answer() });
    await goneLive();
    await ask();
    expect(actions.askEmployee).toHaveBeenCalledWith('Where is my order #1001?');
    expect(screen.getByTestId('go-live-answer')).toHaveTextContent('Your order shipped yesterday.');
    expect(screen.getByTestId('go-live-from-order')).toHaveTextContent(
      /^The answer is based on order #1001 in Shopify\.$/,
    );
  });

  it('★★ the order could not be read: said plainly, never "answered from the order"', async () => {
    actions.askEmployee.mockResolvedValue({
      ok: true,
      test: answer({
        toolsUsed: [{ name: 'shopify.get_order', ok: false }],
        usedRealOrder: false,
        orderNumber: null,
        platform: null,
      }),
    });
    await goneLive();
    await ask();
    expect(screen.getByTestId('go-live-order-unread')).toHaveTextContent(
      "We tried to read the order in the store and couldn't",
    );
    expect(screen.queryByTestId('go-live-from-order')).toBeNull();
  });

  it('from what was learned: its sources named', async () => {
    actions.askEmployee.mockResolvedValue({
      ok: true,
      test: answer({
        toolsUsed: [],
        usedRealOrder: false,
        orderNumber: null,
        platform: null,
        sources: [
          { title: 'Returns policy', sourceType: 'onboarding_scan' },
          { title: '', sourceType: null },
        ],
      }),
    });
    await goneLive();
    await ask();
    expect(screen.getByTestId('go-live-from-knowledge')).toHaveTextContent(
      /^The answer is based on what we learned: Returns policy$/,
    );
  });

  it('★ rate limited: when to try again, in seconds', async () => {
    actions.askEmployee.mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 20,
    });
    await goneLive();
    await ask();
    expect(screen.getByTestId('go-live-test-refused')).toHaveTextContent(
      'Try again in 20 seconds.',
    );
  });

  it('★ an empty question is never sent', async () => {
    await goneLive();
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '  ' } });
    expect(screen.getByTestId('go-live-ask')).toBeDisabled();
    await ask();
    expect(actions.askEmployee).not.toHaveBeenCalled();
  });

  it('★ a test that rejects reads as failed', async () => {
    actions.askEmployee.mockRejectedValue(new Error('Failed to fetch'));
    await goneLive();
    await ask();
    expect(screen.getByTestId('go-live-test-refused')).toHaveTextContent("The test didn't run");
  });
});

describe('★★ Hebrew: never a gendered verb after the name or "העובד"', () => {
  it('the store, with ב joined by a non-breaking hyphen before Latin; the system is the subject', async () => {
    actions.goLive.mockResolvedValue({ ok: true, live: live() });
    actions.askEmployee.mockResolvedValue({ ok: true, test: answer() });
    show({}, true);
    await press();
    expect(screen.getByTestId('go-live-orders')).toHaveTextContent(
      /^יש גישה לקריאת הזמנות ב\u2011Shopify\.$/,
    );
    await act(async () => fireEvent.submit(screen.getByTestId('go-live-test')));
    expect(screen.getByTestId('go-live-from-order')).toHaveTextContent(
      /^התשובה מבוססת על הזמנה #1001 ב\u2011Shopify\.$/,
    );
  });
});

describe('★★ done', () => {
  it('saves "done", THEN goes home', async () => {
    const order: string[] = [];
    steps.saveStep.mockImplementation(async () => {
      await Promise.resolve();
      order.push('saved');
      return true;
    });
    router.push.mockImplementation(() => order.push('home'));
    actions.goLive.mockResolvedValue({ ok: true, live: live() });
    show();
    await press();
    await act(async () => fireEvent.click(screen.getByTestId('go-live-finish')));
    expect(steps.saveStep).toHaveBeenCalledWith('done');
    expect(router.push).toHaveBeenCalledWith('/home');
    expect(order).toEqual(['saved', 'home']);
  });

  it('not before going live', () => {
    show();
    expect(screen.queryByTestId('go-live-finish')).toBeNull();
  });
});
