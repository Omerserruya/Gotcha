'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { Channel, ChannelType } from '@/api/contracts/channels';
import { channelName } from '@/api/contracts/inbox';
import type { WidgetInstall } from '@/api/contracts/website-widget';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { startChannelConnect } from '@/features/channels/actions';
import { ConnectWhatsApp } from '@/features/channels/ConnectWhatsApp';
import { EmailStep } from '@/features/channels/ConnectPanel';
import type { ChannelsConfig } from '@/features/channels/load-whatsapp';
import { CopyCode, GetTheCode } from '@/features/webchat/WebchatSettings';
import { Link, useRouter } from '@/i18n/navigation';

import styles from './Onboarding.module.css';
import { stepHref } from './preview';

/** The channels onboarding offers, in this order (Omer, 2026-10-23). */
export const ONBOARDING_CHANNELS = ['WEBCHAT', 'WHATSAPP', 'INSTAGRAM', 'EMAIL'] as const;
type OnboardingChannel = (typeof ONBOARDING_CHANNELS)[number];

/** The step after this one (check and go live, once it exists). */
export const afterChannels = (preview: boolean) => stepHref('/onboarding/learned', preview);
/** Where a connect flow that leaves the page comes back to. */
const HERE = stepHref('/onboarding/channels', false) as string;

type Standing = 'connected' | 'codeReady' | 'none';

/**
 * Step 3 - channels: where the business's customers write. Each one is
 * connected right here, with the flow the product already has, or skipped.
 *
 * ★ Nothing leaves onboarding on success: the website code is shown and
 *   copied in place (the widget page's own pieces), email connects inline,
 *   and WhatsApp's wizard runs inline and returns HERE. Instagram goes to
 *   Meta and back.
 * ★ The website widget counts once its code exists; "live" only once it was
 *   seen on the site - never claimed before that.
 */
export function ChannelsStep({
  channels,
  install,
  config,
  preview = false,
}: {
  /** `null`: unread. */
  readonly channels: readonly Channel[] | null;
  readonly install: WidgetInstall | null;
  readonly config: ChannelsConfig;
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.channels');
  const tn = useTranslations('onboarding');
  const tc = useTranslations('channels');
  const router = useRouter();
  const [open, setOpen] = useState<OnboardingChannel | null>(null);

  const standing = (channel: OnboardingChannel): Standing => {
    if (channel === 'WEBCHAT') {
      if (!install?.code) return 'none';
      return install.code.status === 'live' ? 'connected' : 'codeReady';
    }
    return channels?.some(
      (each) => each.channel === channel && each.connectionStatus === 'CONNECTED',
    )
      ? 'connected'
      : 'none';
  };
  const anyConnected = ONBOARDING_CHANNELS.some((each) => standing(each) !== 'none');

  return (
    <div className={styles.systemsStep} data-testid="channels">
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>
      {channels === null ? (
        <p className={styles.why} role="alert" data-testid="channels-unread">
          {t('unread')}
        </p>
      ) : null}

      <ul className={styles.suggestions}>
        {ONBOARDING_CHANNELS.map((channel) => {
          const name = channelName(channel, tc) ?? channel;
          const state = standing(channel);
          const isOpen = open === channel;
          return (
            <li key={channel} className={styles.system} data-testid={`channels-${channel}`}>
              <span className={styles.systemHead}>
                <ChannelPlate channel={channel} size="lg" decorative />
                <span className={styles.systemText}>
                  <span className={styles.systemName}>{name}</span>
                  <span className={styles.quiet}>{t(`why.${channel}`)}</span>
                </span>
                {state === 'connected' ? (
                  <span className={styles.connected} data-testid={`channels-connected-${channel}`}>
                    {channel === 'WEBCHAT' ? t('live') : t('connected')}
                  </span>
                ) : state === 'codeReady' ? (
                  <span className={styles.quiet} data-testid={`channels-code-ready-${channel}`}>
                    {t('codeReady')}
                  </span>
                ) : null}
              </span>
              {preview ? (
                <div className={styles.connectHere}>
                  <UnavailableAction
                    label={t('connectName', { name })}
                    tag={tn('preview.tag')}
                    why={tn('preview.why')}
                  />
                </div>
              ) : channel === 'WEBCHAT' ? (
                <Website install={install} />
              ) : state === 'connected' ? null : isOpen ? (
                <div className={styles.connectHere} data-testid={`channels-panel-${channel}`}>
                  {channel === 'EMAIL' ? (
                    <EmailStep
                      note={false}
                      onClose={() => {
                        setOpen(null);
                        router.refresh();
                      }}
                    />
                  ) : channel === 'WHATSAPP' ? (
                    <WhatsApp config={config} />
                  ) : (
                    <Instagram config={config} name={name} />
                  )}
                  {/* Email's form has its own "later"; the others get one way back. */}
                  {channel === 'EMAIL' ? null : (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setOpen(null)}
                      data-testid={`channels-close-${channel}`}
                    >
                      {t('close')}
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.connectHere}>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => setOpen(channel)}
                    data-testid={`channels-open-${channel}`}
                  >
                    {t('connectName', { name })}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <span className={styles.actions}>
        <Link
          href={afterChannels(preview)}
          className={anyConnected ? styles.primary : styles.secondary}
          data-testid="channels-next"
        >
          {anyConnected ? t('next') : t('skip')}
        </Link>
      </span>
      {anyConnected ? null : (
        <p className={styles.quiet} data-testid="channels-skip-why">
          {t('skipWhy')}
        </p>
      )}
    </div>
  );
}

/** The website widget: its code, copied here; or the one press that makes it. */
function Website({ install }: { readonly install: WidgetInstall | null }) {
  const t = useTranslations('onboarding.channels');
  if (install === null) {
    return (
      <p className={styles.why} data-testid="channels-code-unread">
        {t('codeUnread')}
      </p>
    );
  }
  if (!install.code) {
    return (
      <div className={styles.connectHere} data-testid="channels-get-code">
        <GetTheCode />
      </div>
    );
  }
  return (
    <div className={styles.connectHere} data-testid="channels-code">
      <span className={styles.quiet}>{t('pasteCode')}</span>
      <pre className={styles.code} dir="ltr" data-testid="channels-code-snippet">
        {install.code.snippet}
      </pre>
      <CopyCode code={install.code.snippet} />
    </div>
  );
}

/** WhatsApp's wizard, inline, coming back HERE; or why it can't start from here. */
function WhatsApp({ config }: { readonly config: ChannelsConfig }) {
  const t = useTranslations('onboarding.channels');
  const { coexistence, newNumber } = config.launches;
  if (!coexistence?.configured && !newNumber?.configured) {
    return (
      <p className={styles.why} data-testid="channels-whatsapp-unavailable">
        {t('notSetUp')}
      </p>
    );
  }
  return <ConnectWhatsApp launches={config.launches} closeHref={HERE} />;
}

/** Instagram: at Meta, and back. Nothing is connected until the person approves there. */
function Instagram({ config, name }: { readonly config: ChannelsConfig; readonly name: string }) {
  const t = useTranslations('onboarding.channels');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  if (config.providers !== null && config.providers.instagram === false) {
    return (
      <p className={styles.why} data-testid="channels-instagram-unavailable">
        {t('notSetUp')}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className={styles.primary}
        disabled={isPending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            const started = await startChannelConnect('INSTAGRAM' satisfies ChannelType).catch(
              () => ({ ok: false, reason: 'failed' }) as const,
            );
            if (started.ok) window.location.assign(started.url);
            else setProblem(started.reason);
          })
        }
        data-testid="channels-instagram-go"
      >
        {isPending ? t('opening') : t('atMeta', { name })}
      </button>
      <span className={styles.quiet}>{t('metaNote')}</span>
      {problem ? (
        <p className={styles.problem} role="alert" data-testid="channels-instagram-problem">
          {t(`refused.${problem}`)}
        </p>
      ) : null}
    </>
  );
}
