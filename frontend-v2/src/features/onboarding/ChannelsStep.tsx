'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type ReactNode } from 'react';

import type { Channel, ChannelType } from '@/api/contracts/channels';
import { channelName } from '@/api/contracts/inbox';
import type { WidgetInstall } from '@/api/contracts/website-widget';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { startChannelConnect } from '@/features/channels/actions';
import { ConnectWhatsApp } from '@/features/channels/ConnectWhatsApp';
import { EmailStep } from '@/features/channels/ConnectPanel';
import type { ChannelLanding } from '@/features/channels/landing';
import type { ChannelsConfig } from '@/features/channels/load-whatsapp';
import type { MessengerPagesRead } from '@/features/channels/messenger-actions';
import { MessengerPicker } from '@/features/channels/MessengerPicker';
import { CopyCode, GetTheCode } from '@/features/webchat/WebchatSettings';
import { useRouter } from '@/i18n/navigation';

import {
  accountsOf,
  answers,
  ONBOARDING_CHANNELS,
  reaches,
  rowOf,
  shopLive,
  type OnboardingChannel,
} from './channel-reach';
import styles from './Onboarding.module.css';
import { stepHref } from './preview';
import { StepLink } from './StepLink';

export { ONBOARDING_CHANNELS };

/** The step after this one: check and go live. */
export const afterChannels = (preview: boolean) => stepHref('/onboarding/live', preview);
/** Where a connect flow that leaves the page comes back to. */
const HERE = stepHref('/onboarding/channels', false) as string;
/** The provider sends the browser back HERE (backend 2c1653b0), never to Settings. */
const FLOW = 'onboarding_channels' as const;

/**
 * A row's standing. `waiting`: the website's code exists, or its shop has the
 * app, but no customer can write yet. `attention`: an account exists and
 * answers nobody (an error, not finished, or the way back said so).
 */
type Standing = 'connected' | 'waiting' | 'attention' | 'none';

type Pick = { readonly session: string; readonly read: MessengerPagesRead };

/** A shop not live yet whose theme can switch the chat on: the one way offered. */
const themePath = (install: WidgetInstall | null) =>
  (install?.shopify ?? []).some(
    (shop) => shop.status !== 'uninstalled' && !shopLive(shop) && shop.themeEditorUrl !== null,
  );

/** What a row names a connected account by, as 13's rows do. */
const identityOf = (each: Channel) => each.displayName?.trim() || each.externalId?.trim() || null;

/** An account that is there and answers nobody. */
const troubled = (each: Channel) =>
  each.connectionStatus === 'ERROR' ||
  each.connectionStatus === 'PENDING' ||
  (each.connectionStatus === 'CONNECTED' && each.isActive === false) ||
  (each.connectionStatus !== 'DISCONNECTED' && Boolean(each.lastError));

/** Where an OAuth connect sends the browser, as its row's sentence names it. */
const PLACE: Partial<Record<ChannelType, string>> = {
  INSTAGRAM: 'Meta',
  MESSENGER: 'Meta',
  GMAIL: 'Gmail',
  OUTLOOK: 'Outlook',
};

/** The key `/api/channels/config`'s `providers` names each one by. */
const PROVIDER: Partial<Record<ChannelType, string>> = {
  INSTAGRAM: 'instagram',
  MESSENGER: 'messenger',
  GMAIL: 'gmail',
  OUTLOOK: 'outlook',
};

/** The provider's credentials are known to be missing here: no Connect is offered. */
const notSetUp = (channel: ChannelType, config: ChannelsConfig) =>
  config.providers !== null && config.providers[PROVIDER[channel] ?? ''] === false;

/**
 * Step 3 - channels: where the business's customers write. One list, one row
 * per channel: its mark, name and line, where it stands, and one action
 * (Omer, 2026-10-24: not four cards far apart).
 *
 * ★ Nothing leaves onboarding on success: the website code is shown and
 *   copied in place, email (a server's mailbox) connects inline, WhatsApp's
 *   wizard runs inline and closes in place. Instagram, Messenger, Gmail and
 *   Outlook go to the provider and come back HERE (`flow=onboarding_channels`),
 *   with the query 13 reads: the outcome is said on its own row, Messenger's
 *   Pages are chosen on its row, and the URL is tidied.
 * ★ The website widget counts once its code was seen on the site; "live"
 *   only then - never claimed before that.
 */
export function ChannelsStep({
  channels,
  install,
  config,
  landing = null,
  pick = null,
  preview = false,
}: {
  /** `null`: unread. */
  readonly channels: readonly Channel[] | null;
  readonly install: WidgetInstall | null;
  readonly config: ChannelsConfig;
  /** The way back from a provider, read off the URL (`channelLandingOf`). */
  readonly landing?: ChannelLanding | null;
  /** Messenger came back with Pages to choose (`messengerPickOf` and its read). */
  readonly pick?: Pick | null;
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.channels');
  const router = useRouter();
  const [open, setOpen] = useState<OnboardingChannel | null>(null);
  // Held from the first render: the URL is tidied next, and the sentence stays.
  const [said] = useState(landing);

  useEffect(() => {
    if (landing === null) return;
    router.replace(HERE, { scroll: false });
  }, [landing, router]);

  const saidOn = said?.channel ? rowOf(said.channel) : null;

  // Connected only where a customer can write (channel-reach). A way back that
  // says "connected, but nothing arrives" outranks the CONNECTED it wrote.
  const standing = (channel: OnboardingChannel): Standing => {
    if (saidOn === channel && said?.outcome === 'connected' && said.pending) return 'attention';
    if (reaches(channel, channels, install)) return 'connected';
    if (channel === 'WEBCHAT') return install?.code || themePath(install) ? 'waiting' : 'none';
    return accountsOf(channel, channels).some(troubled) ? 'attention' : 'none';
  };
  const anyConnected = ONBOARDING_CHANNELS.some((each) => standing(each) === 'connected');
  const toggle = (channel: OnboardingChannel) =>
    setOpen((now) => (now === channel ? null : channel));
  const close = () => {
    setOpen(null);
    router.refresh();
  };

  return (
    <div className={styles.systemsStep} data-testid="channels">
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>
      {channels === null ? (
        <p className={styles.why} role="alert" data-testid="channels-unread">
          {t('unread')}
        </p>
      ) : null}
      {/* A way back that names no row of ours (v1's, or Slack's): said over the list. */}
      {said && saidOn === null ? <Landing said={said} testid="channels-landing" /> : null}

      <ul className={styles.channelList}>
        {ONBOARDING_CHANNELS.map((channel) => (
          <Row
            key={channel}
            channel={channel}
            state={standing(channel)}
            channels={channels}
            install={install}
            config={config}
            preview={preview}
            isOpen={open === channel}
            onToggle={() => toggle(channel)}
            onClose={close}
            said={saidOn === channel ? said : null}
            pick={channel === 'MESSENGER' ? pick : null}
          />
        ))}
      </ul>

      <div className={styles.channelsFoot}>
        <StepLink
          href={afterChannels(preview)}
          step="live"
          preview={preview}
          className={anyConnected ? styles.primary : styles.channelSkip}
          data-testid="channels-next"
        >
          {anyConnected ? t('next') : t('skip')}
        </StepLink>
        {anyConnected ? null : (
          <p className={styles.quiet} data-testid="channels-skip-why">
            {t('skipWhy')}
          </p>
        )}
      </div>
    </div>
  );
}

/** One channel's row: mark, name, line, where it stands, one action; its panel under it. */
function Row({
  channel,
  state,
  channels,
  install,
  config,
  preview,
  isOpen,
  onToggle,
  onClose,
  said,
  pick,
}: {
  readonly channel: OnboardingChannel;
  readonly state: Standing;
  readonly channels: readonly Channel[] | null;
  readonly install: WidgetInstall | null;
  readonly config: ChannelsConfig;
  readonly preview: boolean;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly said: ChannelLanding | null;
  readonly pick: Pick | null;
}) {
  const t = useTranslations('onboarding.channels');
  const tn = useTranslations('onboarding');
  const tc = useTranslations('channels');
  const name = channelName(channel, tc) ?? channel;
  const oauth = channel === 'INSTAGRAM' || channel === 'MESSENGER';
  const connect = useProviderConnect();
  const identity =
    channel === 'WEBCHAT'
      ? ((install?.shopify ?? []).find(shopLive)?.shopDomain ?? install?.code?.lastHost ?? null)
      : (accountsOf(channel, channels).filter(answers).map(identityOf).find(Boolean) ?? null);
  const unavailable =
    (oauth && notSetUp(channel, config)) ||
    (channel === 'WHATSAPP' &&
      !config.launches.coexistence?.configured &&
      !config.launches.newNumber?.configured);
  const waitingOnTheme = channel === 'WEBCHAT' && themePath(install);

  /** The one action. Connected rows are done: they have none. */
  const action: ReactNode =
    state === 'connected' ? null : preview ? (
      <UnavailableAction
        label={t('action.connect')}
        tag={tn('preview.tag')}
        why={tn('preview.why')}
      />
    ) : unavailable ? null : oauth ? (
      // Straight to the provider: there is nothing to fill in here first.
      <button
        type="button"
        className={styles.channelAction}
        disabled={connect.pending}
        onClick={() => connect.start(channel)}
        data-testid={`channels-open-${channel}`}
      >
        {connect.pending
          ? t('opening', { place: PLACE[channel] ?? name })
          : state === 'attention'
            ? t('action.again')
            : t('action.connect')}
      </button>
    ) : (
      <button
        type="button"
        className={styles.channelAction}
        aria-expanded={isOpen}
        onClick={onToggle}
        data-testid={`channels-open-${channel}`}
      >
        {isOpen
          ? t('close')
          : channel === 'WEBCHAT'
            ? t('action.install')
            : state === 'attention'
              ? t('action.again')
              : t('action.connect')}
      </button>
    );

  return (
    <li
      className={styles.channelRow}
      data-state={state}
      data-open={isOpen || undefined}
      data-testid={`channels-${channel}`}
    >
      <div className={styles.channelLine}>
        <ChannelPlate channel={channel} size="xl" decorative />
        <span className={styles.channelText}>
          <span className={styles.channelName}>{name}</span>
          <span className={styles.channelWhy}>{t(`why.${channel}`)}</span>
        </span>
        <span className={styles.channelEnd}>
          <span
            className={styles.channelStatus}
            data-state={state}
            data-testid={`channels-status-${channel}`}
          >
            {state === 'connected' ? (
              <>
                <span data-testid={`channels-connected-${channel}`}>
                  {channel === 'WEBCHAT' ? t('live') : t('connected')}
                </span>
                {identity ? (
                  <bdi
                    className={styles.channelIdentity}
                    data-testid={`channels-identity-${channel}`}
                  >
                    {identity}
                  </bdi>
                ) : null}
              </>
            ) : (
              t(`status.${state}`)
            )}
          </span>
          {action}
        </span>
      </div>

      {/* What the row says under its line: the way back, a refusal, what it waits for. */}
      {said ? <Landing said={said} testid={`channels-landing-${channel}`} /> : null}
      {connect.problem ? (
        <p
          className={styles.channelSays}
          data-outcome="problem"
          role="alert"
          data-testid={`channels-problem-${channel}`}
        >
          {t(`refused.${connect.problem.reason}`, { place: connect.problem.place })}
        </p>
      ) : null}
      {unavailable && !preview && state !== 'connected' ? (
        <p className={styles.channelSays} data-testid={`channels-unavailable-${channel}`}>
          {t('notSetUp')}
        </p>
      ) : null}
      {state === 'attention' && !said ? (
        <p
          className={styles.channelSays}
          data-outcome="problem"
          data-testid={`channels-attention-${channel}`}
        >
          {t('attention')}
        </p>
      ) : null}
      {/* The waiting line names the way offered: the theme toggle, or the code. */}
      {channel === 'WEBCHAT' && state === 'waiting' && !isOpen ? (
        <p
          className={styles.channelSays}
          data-testid={
            waitingOnTheme ? 'channels-shop-waiting-WEBCHAT' : 'channels-code-ready-WEBCHAT'
          }
        >
          {waitingOnTheme ? t('shopNotLive') : t('codeReady')}
        </p>
      ) : null}

      {/* Always mounted: it holds Messenger's Pages after the URL is tidied. */}
      {channel === 'MESSENGER' && !preview ? (
        <div className={styles.channelPick}>
          <MessengerPicker pick={pick} here={HERE} flow={FLOW} />
        </div>
      ) : null}

      {isOpen && !preview ? (
        <div className={styles.channelPanel} data-testid={`channels-panel-${channel}`}>
          {channel === 'WEBCHAT' ? (
            <Website install={install} />
          ) : channel === 'WHATSAPP' ? (
            <ConnectWhatsApp
              launches={config.launches}
              closeHref={HERE}
              onCancel={onClose}
              onDone={onClose}
            />
          ) : channel === 'EMAIL' ? (
            <Email config={config} onClose={onClose} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The sentence a way back earns, on its row (or over the list when it names none). */
function Landing({ said, testid }: { readonly said: ChannelLanding; readonly testid: string }) {
  const t = useTranslations('onboarding.channels.landing');
  const ok = said.outcome === 'connected' && !said.pending && said.count !== 0;
  return (
    <p
      className={styles.channelSays}
      role="status"
      data-outcome={ok ? 'ok' : 'problem'}
      data-testid={testid}
    >
      {said.outcome === 'connected'
        ? said.pending
          ? said.reason
            ? t(`pendingReason.${said.reason}`)
            : said.channel === 'WHATSAPP'
              ? t('pendingWhatsApp')
              : t('pending')
          : said.count === null
            ? t('connected')
            : t('connectedCount', { count: said.count })
        : t(`error.${said.outcome}`)}
    </p>
  );
}

type ConnectRefusal = 'not_configured' | 'forbidden' | 'failed';

/** To the provider, and back HERE. Nothing is connected until the person approves there. */
function useProviderConnect() {
  const [problem, setProblem] = useState<{ reason: ConnectRefusal; place: string } | null>(null);
  const [pending, start] = useTransition();
  return {
    pending,
    problem,
    start: (channel: ChannelType) =>
      start(async () => {
        setProblem(null);
        const started = await startChannelConnect(channel, FLOW).catch(
          () => ({ ok: false, reason: 'failed' }) as const,
        );
        if (started.ok) window.location.assign(started.url);
        else setProblem({ reason: started.reason, place: PLACE[channel] ?? channel });
      }),
  };
}

/** Email: Gmail or Outlook at the provider, or any other mailbox's server, inline. */
function Email({
  config,
  onClose,
}: {
  readonly config: ChannelsConfig;
  readonly onClose: () => void;
}) {
  const t = useTranslations('onboarding.channels');
  const connect = useProviderConnect();
  const [server, setServer] = useState(false);
  const offered = (['GMAIL', 'OUTLOOK'] as const).filter((each) => !notSetUp(each, config));
  return (
    <div className={styles.connectHere} data-testid="channels-email">
      <span className={styles.channelWhy}>{t('email.lead')}</span>
      <span className={styles.channelChoices}>
        {offered.map((each) => (
          <button
            key={each}
            type="button"
            className={styles.channelAction}
            disabled={connect.pending}
            onClick={() => connect.start(each)}
            data-testid={`channels-email-${each}`}
          >
            {PLACE[each]}
          </button>
        ))}
        <button
          type="button"
          className={styles.channelAction}
          aria-pressed={server}
          onClick={() => setServer((now) => !now)}
          data-testid="channels-email-server"
        >
          {t('email.server')}
        </button>
      </span>
      {connect.pending ? <span className={styles.quiet}>{t('email.opening')}</span> : null}
      {connect.problem ? (
        <p className={styles.problem} role="alert" data-testid="channels-problem-email">
          {t(`refused.${connect.problem.reason}`, { place: connect.problem.place })}
        </p>
      ) : null}
      {server ? (
        <div className={styles.channelServer}>
          <EmailStep note={false} onClose={onClose} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The website widget. A Shopify shop with GOTCHA installed is the easy way:
 * switch the chat on in its theme (Shopify's editor, one toggle), above the
 * code. Otherwise the code, copied here; or the one press that makes it.
 */
function Website({ install }: { readonly install: WidgetInstall | null }) {
  const t = useTranslations('onboarding.channels');
  const [showCode, setShowCode] = useState(false);
  if (install === null) {
    return (
      <p className={styles.why} data-testid="channels-code-unread">
        {t('codeUnread')}
      </p>
    );
  }
  const shops = install.shopify.filter((shop) => shop.status !== 'uninstalled');
  return (
    <div className={styles.connectHere} data-testid="channels-website">
      {shops.map((shop) => (
        <div
          key={shop.channelId}
          className={styles.connectHere}
          data-testid={`channels-shop-${shop.channelId}`}
        >
          <span className={styles.quiet}>
            {t.rich('shop', {
              shop: shop.shopDomain,
              ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </span>
          {shopLive(shop) ? (
            <span className={styles.connected}>{t('shopLive')}</span>
          ) : shop.themeEditorUrl ? (
            <>
              <a
                href={shop.themeEditorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.primary}
                data-testid={`channels-shop-theme-${shop.channelId}`}
              >
                {t('shopTheme')}
              </a>
              <span className={styles.quiet}>{t('shopThemeHow')}</span>
            </>
          ) : (
            <span className={styles.quiet}>{t('shopWaiting')}</span>
          )}
        </div>
      ))}
      {/* One clear action: with the theme path offered, the code waits under a quiet toggle. */}
      {themePath(install) && !showCode ? (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setShowCode(true)}
          data-testid="channels-show-code"
        >
          {t('pasteYourself')}
        </button>
      ) : install.code ? (
        <>
          <span className={styles.quiet}>{t('pasteCode')}</span>
          {/* The server's snippet, verbatim; it scrolls in its own box and copies whole. */}
          <pre className={styles.code} dir="ltr" data-testid="channels-code-snippet">
            {install.code.snippet}
          </pre>
          <CopyCode code={install.code.snippet} />
        </>
      ) : (
        <div className={styles.connectHere} data-testid="channels-get-code">
          <GetTheCode />
        </div>
      )}
    </div>
  );
}
