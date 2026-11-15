import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/* ⚠ Mocked - nothing reaches Meta or the platform. */
const { actions, refresh, meta } = vi.hoisted(() => ({
  actions: {
    connectPlatformNumber: vi.fn(),
    recheckPlatformNumber: vi.fn(),
    disconnectPlatformNumber: vi.fn(),
  },
  refresh: vi.fn(),
  meta: {
    current: {
      sdk: 'ready' as 'ready' | 'loading' | 'unavailable',
      stage: 'idle' as 'idle' | 'authorizing' | 'reading',
      problem: null as string | null,
      result: null as unknown,
      start: vi.fn(),
      reset: vi.fn(),
    },
    exchange: null as null | ((code: string, assets: object) => Promise<unknown>),
  },
}));
vi.mock('./platform-whatsapp-actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('../../channels/signup/use-meta-code', () => ({
  useMetaCode: (_appId: string, exchange: (code: string, assets: object) => Promise<unknown>) => {
    meta.exchange = exchange;
    return meta.current;
  },
}));

import { sender } from './fixtures';
import { PlatformNumber } from './PlatformNumber';

const w = consoleEn.platformWhatsApp;
const show = (over: Record<string, unknown> = {}, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{ console: he ? consoleHe : consoleEn }}
    >
      <PlatformNumber sender={sender(over)} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true });
  }
  refresh.mockClear();
  meta.current = { ...meta.current, sdk: 'ready', stage: 'idle', problem: null, result: null };
  meta.current.start.mockClear();
});

describe('★★ GOTCHA’s alerts number, by state', () => {
  it('★★ not connected: says nothing goes out, offers Connect, shows no number', () => {
    show({ status: 'DISCONNECTED', number: null, connectedAt: null, connectedBy: null });
    expect(screen.getByTestId('platform-status-sentence')).toHaveTextContent(w.status.DISCONNECTED);
    expect(screen.getByTestId('platform-connect-start')).toHaveTextContent(w.connect.action);
    expect(screen.getByTestId('platform-connect-needs')).toHaveTextContent(w.connect.needs);
    expect(screen.queryByTestId('platform-facts')).toBeNull();
    expect(screen.queryByTestId('platform-disconnect-open')).toBeNull();
    expect(screen.queryByTestId('platform-recheck')).toBeNull();
  });

  it('★★ a disconnected row that once had a number shows Connect, not the old number', () => {
    show({ status: 'DISCONNECTED' });
    expect(screen.queryByTestId('platform-facts')).toBeNull();
    expect(screen.getByTestId('platform-connect-start')).toBeInTheDocument();
  });

  it('★★ connected: the number, left to right, and Check, Disconnect, Retire; no Connect', () => {
    show();
    expect(screen.getByTestId('platform-status')).toHaveTextContent(w.badge.CONNECTED);
    expect(screen.getByTestId('platform-display')).toHaveTextContent('+972 50 000 0000');
    expect(screen.getByTestId('platform-display')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('platform-facts')).toHaveTextContent(w.quality.GREEN);
    expect(screen.getByTestId('platform-recheck')).toBeInTheDocument();
    expect(screen.getByTestId('platform-disconnect-open')).toBeInTheDocument();
    expect(screen.getByTestId('platform-retire-open')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-connect')).toBeNull();
  });

  it('★★ token expired: said as a stop, with Connect again', () => {
    show({ status: 'TOKEN_INVALID', lastErrorCode: 'TOKEN_INVALID' });
    expect(screen.getByTestId('platform-stopped')).toHaveTextContent(w.stoppedTitle);
    expect(screen.getByTestId('platform-connect-start')).toHaveTextContent(w.connect.again);
    // The same number again: not the new-number rules.
    expect(screen.queryByTestId('platform-connect-needs')).toBeNull();
  });

  it('★ replies not arriving: still sends, says so, offers Check', () => {
    show({ status: 'PENDING_WEBHOOK' });
    expect(screen.getByTestId('platform-status-sentence')).toHaveTextContent(
      w.status.PENDING_WEBHOOK,
    );
    expect(screen.getByTestId('platform-recheck')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-stopped')).toBeNull();
  });

  it('★ the env pair sending, or overridden, is said', () => {
    show({ status: 'DISCONNECTED', number: null, source: 'env', envPresent: true });
    expect(screen.getByTestId('platform-source-env')).toHaveTextContent(w.source.env);
    show({ source: 'db', envPresent: true });
    expect(screen.getByTestId('platform-source-db-over-env')).toBeInTheDocument();
  });

  it('★★ Connect opens Meta’s window with the route’s launch', () => {
    show({ status: 'DISCONNECTED', number: null });
    fireEvent.click(screen.getByTestId('platform-connect-start'));
    expect(meta.current.start).toHaveBeenCalledWith(expect.objectContaining({ configId: 'cfg' }));
  });

  it('★ a launch the server has not set up is said, and Connect is held', () => {
    show({
      status: 'DISCONNECTED',
      number: null,
      launch: { appId: '', configId: '', configured: false },
    });
    expect(screen.getByTestId('platform-connect-start')).toBeDisabled();
    expect(screen.getByTestId('platform-connect-not-configured')).toHaveTextContent(
      w.connect.problem.notConfigured,
    );
  });

  it('★★ a refusal from connect is the route’s code in words', () => {
    meta.current = {
      ...meta.current,
      result: { ok: false, reason: 'number_belongs_to_workspace' },
    };
    show({ status: 'DISCONNECTED', number: null });
    expect(screen.getByTestId('platform-connect-refused')).toHaveTextContent(
      w.refusal.number_belongs_to_workspace,
    );
  });

  it('★ waiting on Meta’s window is said', () => {
    meta.current = { ...meta.current, stage: 'authorizing' };
    show({ status: 'DISCONNECTED', number: null });
    expect(screen.getByTestId('platform-connect-waiting')).toHaveTextContent(w.connect.waiting);
    expect(screen.getByTestId('platform-connect-start')).toBeDisabled();
  });

  it('★★ retire waits for the number typed back, then deregisters', async () => {
    show();
    fireEvent.click(screen.getByTestId('platform-retire-open'));
    expect(screen.getByTestId('platform-retire-yes')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(w.retire.match), {
      target: { value: '+972 50 000 0000' },
    });
    await act(async () => fireEvent.click(screen.getByTestId('platform-retire-yes')));
    expect(actions.disconnectPlatformNumber).toHaveBeenCalledWith(true);
  });

  it('★★ disconnect asks, then unlinks only', async () => {
    show();
    fireEvent.click(screen.getByTestId('platform-disconnect-open'));
    await act(async () => fireEvent.click(screen.getByTestId('platform-disconnect-yes')));
    expect(actions.disconnectPlatformNumber).toHaveBeenCalledWith(false);
  });

  it('★ check with Meta: done is said and the page reads again; a refusal in words', async () => {
    show();
    await act(async () => fireEvent.click(screen.getByTestId('platform-recheck')));
    expect(screen.getByTestId('platform-recheck-outcome')).toHaveTextContent(w.recheck.done);
    expect(refresh).toHaveBeenCalled();
    actions.recheckPlatformNumber.mockResolvedValue({ ok: false, reason: 'meta_error' });
    await act(async () => fireEvent.click(screen.getByTestId('platform-recheck')));
    expect(screen.getByTestId('platform-recheck-outcome')).toHaveTextContent(w.refusal.meta_error);
  });

  it('★ Hebrew: the stop said in Hebrew, the number still left to right', () => {
    show({ status: 'TOKEN_INVALID' }, true);
    expect(screen.getByTestId('platform-stopped')).toHaveTextContent(
      consoleHe.platformWhatsApp.stoppedTitle,
    );
    expect(screen.getByTestId('platform-display')).toHaveAttribute('dir', 'ltr');
  });

  it('★★ a state with no name: Check with Meta only, never Disconnect or Retire on a guess', () => {
    show({ status: 'SOMETHING_NEW' });
    expect(screen.getByTestId('platform-status')).toHaveTextContent(w.badge.UNKNOWN);
    expect(screen.getByTestId('platform-recheck')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-disconnect-open')).toBeNull();
    expect(screen.queryByTestId('platform-retire-open')).toBeNull();
  });

  it('★★ the WABA is sent only when Meta named exactly one; the picked number always', async () => {
    show({ status: 'DISCONNECTED', number: null });
    await meta.exchange!('c1', { wabaIds: ['w1', 'w2'], phoneNumberId: 'pn_9' });
    expect(actions.connectPlatformNumber).toHaveBeenLastCalledWith('c1', {
      wabaId: undefined,
      phoneNumberId: 'pn_9',
    });
    await meta.exchange!('c2', { wabaIds: ['w1'] });
    expect(actions.connectPlatformNumber).toHaveBeenLastCalledWith('c2', {
      wabaId: 'w1',
      phoneNumberId: undefined,
    });
  });
});
