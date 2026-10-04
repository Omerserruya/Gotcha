'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  OAUTH_PLATFORMS,
  RESPONSE_MODES,
  type ChannelType,
  type ResponseMode,
} from '@/api/contracts/channels';
import { Link } from '@/i18n/navigation';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import {
  connectEmail,
  connectWebChat,
  setResponseMode,
  startChannelConnect,
  type ChannelWriteResult,
} from './actions';
import { TwilioStep } from './TwilioStep';
import styles from './Channels.module.css';
import { channelName } from '@/api/contracts/inbox';

/**
 * *"Connecting is a two-step task, not an integration form."*
 *
 * It is not one component with a parameter, because connecting is not one
 * mechanism. Three shapes, and which one a channel gets is a property of the
 * channel:
 *
 *   - **provisioned** — web chat. Nothing is authorised anywhere; the backend
 *     creates the widget as `PENDING`, a draft until it is on a page. The only
 *     connect path with no third party in it.
 *   - **credentials** — email. SMTP and IMAP details typed in and stored.
 *   - **authorised** — the six OAuth platforms, and voice, neither of which
 *     can complete from this app today. See `unavailable` below.
 *
 * A panel shows ONE of these. Pretending they share a wizard would mean a
 * component whose every branch is a different feature.
 */

type ConnectShape = 'provisioned' | 'credentials' | 'oauth' | 'whatsapp' | 'twilio' | 'unavailable';

function shapeOf(channel: ChannelType): ConnectShape {
  if (channel === 'WEBCHAT') return 'provisioned';
  if (channel === 'EMAIL') return 'credentials';
  // Phone calls with the merchant's own Twilio: fields, then its numbers.
  if (channel === 'VOICE') return 'twilio';
  // 13c: WhatsApp has its own sheet — the question, then Meta.
  if (channel === 'WHATSAPP') return 'whatsapp';
  // Live (backend ecd64c4d): the provider's page, and back to this list.
  if (channel in OAUTH_PLATFORMS) return 'oauth';
  return 'unavailable';
}

export function ConnectPanel({
  channel,
  onClose,
}: {
  readonly channel: ChannelType;
  readonly onClose: () => void;
}) {
  const t = useTranslations('channels');
  const shape = shapeOf(channel);
  const name = channelName(channel, t) ?? t('name.other');

  return (
    <div className={styles.connect} data-testid="connect-panel" data-shape={shape}>
      <div className={styles.connectHead}>
        <span className={styles.connectTitle}>{t('connect.heading', { channel: name })}</span>
        <button
          type="button"
          className={styles.connectClose}
          onClick={onClose}
          aria-label={t('connect.close')}
          data-testid="connect-close"
        >
          ✕
        </button>
      </div>

      {shape === 'provisioned' ? <WebChatStep onClose={onClose} /> : null}
      {shape === 'credentials' ? <EmailStep onClose={onClose} /> : null}
      {shape === 'oauth' ? <OAuthStep channel={channel} name={name} /> : null}
      {shape === 'twilio' ? <TwilioStep onClose={onClose} /> : null}
      {shape === 'whatsapp' ? (
        <Link
          href="/settings/channels?panel=whatsapp&view=connect"
          className={styles.connectOpen}
          data-testid="connect-whatsapp-sheet"
        >
          {t('connect.connect')}
        </Link>
      ) : null}
      {shape === 'unavailable' ? (
        /*
         * Stated, not hidden and not faked.
         *
         * The six OAuth platforms authorise at the provider and the provider
         * returns the browser to whichever app `FRONTEND_URL` names — which is
         * not this one. So the handshake would start here and finish somewhere
         * else, leaving a person authorised, confused, and looking at a
         * different product.
         *
         * A Connect button that does that is worse than no button, and a
         * disabled button with no reason is worse than either. So the row says
         * what it can and cannot do, in words a reader can act on: this is not
         * something they have configured wrongly.
         */
        <p className={styles.connectNote} data-testid="connect-unavailable">
          {t('connect.unavailable', { channel: name })}
        </p>
      ) : null}

      {/*
        What happens afterwards, which the design asks for by name. It is the
        same for every channel because it is a fact about the product, not
        about the connection: conversations land in one inbox and count once.
      */}
      <p className={styles.connectThen}>{t('connect.then')}</p>
    </div>
  );
}

/** Web chat: one field, and it is optional. */
function WebChatStep({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('channels');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ResponseMode>('HUMAN_WITH_COPILOT');
  const [result, setResult] = useState<ChannelWriteResult<unknown> | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Created: the code to paste on the site, in this same panel.
  if (widgetId) return <EmbedSnippet widgetId={widgetId} onClose={onClose} />;

  return (
    <>
      <Input
        label={t('connect.webchatName')}
        value={name}
        maxLength={100}
        hint={t('connect.webchatHint')}
        onChange={(e) => setName(e.target.value)}
      />
      <WhoAnswers value={mode} onChange={setMode} />
      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="connect-webchat-create"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await connectWebChat(name);
              setResult(outcome);
              if (!outcome.ok) return;
              /*
               * Step 2, applied to the channel step 1 just created.
               *
               * Two calls, and the second can fail after the first has
               * succeeded — which on screen 12 was the reason NOT to build a
               * role selector. It is acceptable here because the failure is
               * repairable: the channel exists and visibly carries the wrong
               * mode, and the same control is on the row. Nobody has been
               * emailed and no outside party has been told anything.
               */
              await setResponseMode(outcome.data.id, mode);
              // The widget is known by its external id; without one there is no code to give.
              if (outcome.data.externalId) setWidgetId(outcome.data.externalId);
              else onClose();
            })
          }
        >
          {isPending ? t('connect.creating') : t('connect.create')}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t('connect.later')}
        </Button>
      </div>
      {result && !result.ok ? <Problem result={result} /> : null}
    </>
  );
}

/**
 * Email: SMTP, and IMAP if they want us to read as well as send.
 *
 * Never submitted by a capture. This stores a mailbox password, and a test
 * that fills it in has handed someone's credential to a system on their
 * behalf.
 */
function EmailStep({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('channels');
  const [mode, setMode] = useState<ResponseMode>('HUMAN_WITH_COPILOT');
  const [form, setForm] = useState({
    emailAddress: '',
    displayName: '',
    smtpHost: '',
    smtpPort: '587',
    smtpUser: '',
    smtpPass: '',
  });
  const [result, setResult] = useState<ChannelWriteResult<unknown> | null>(null);
  const [isPending, startTransition] = useTransition();

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const fields = result && !result.ok && result.reason === 'invalid' ? result.fields : {};
  const port = Number.parseInt(form.smtpPort, 10);
  const ready =
    form.emailAddress.trim() &&
    form.displayName.trim() &&
    form.smtpHost.trim() &&
    form.smtpUser.trim() &&
    form.smtpPass &&
    Number.isFinite(port);

  return (
    <>
      <div className={styles.connectFields}>
        <Input
          label={t('connect.emailAddress')}
          type="email"
          value={form.emailAddress}
          onChange={set('emailAddress')}
          {...(fields.emailAddress ? { error: fields.emailAddress } : {})}
        />
        <Input
          label={t('connect.emailDisplayName')}
          value={form.displayName}
          onChange={set('displayName')}
        />
        <Input label={t('connect.smtpHost')} value={form.smtpHost} onChange={set('smtpHost')} />
        <Input
          label={t('connect.smtpPort')}
          type="number"
          inputMode="numeric"
          value={form.smtpPort}
          onChange={set('smtpPort')}
        />
        <Input label={t('connect.smtpUser')} value={form.smtpUser} onChange={set('smtpUser')} />
        <Input
          label={t('connect.smtpPass')}
          type="password"
          // Never offered to a password manager as a login for THIS site: it
          // is a credential for someone else's mail server.
          autoComplete="off"
          value={form.smtpPass}
          onChange={set('smtpPass')}
        />
      </div>

      <WhoAnswers value={mode} onChange={setMode} />

      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="connect-email-submit"
          disabled={isPending || !ready}
          onClick={() =>
            startTransition(async () => {
              const outcome = await connectEmail({ ...form, smtpPort: port });
              setResult(outcome);
              if (!outcome.ok) return;
              await setResponseMode(outcome.data.id, mode);
              onClose();
            })
          }
        >
          {isPending ? t('connect.connecting') : t('connect.connect')}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t('connect.later')}
        </Button>
      </div>
      {result && !result.ok ? <Problem result={result} /> : null}
    </>
  );
}

/**
 * Step 2 — *"Who should answer it?"*
 *
 * The design offers a choice of AI employees and human teams. A
 * `ChannelAccount` stores neither: it has no `aiAgentId`, no `departmentId`
 * and no owner field of any kind. What it does store is `responseMode`, which
 * is a genuine routing decision and the one the system can act on.
 *
 * So this is not a reduced version of the design's control. It is the
 * question the product can actually answer.
 */
function WhoAnswers({
  value,
  onChange,
}: {
  readonly value: ResponseMode;
  readonly onChange: (mode: ResponseMode) => void;
}) {
  const t = useTranslations('channels');
  return (
    <fieldset className={styles.whoAnswers} data-testid="connect-who-answers">
      <legend className={styles.connectLegend}>{t('connect.whoAnswers')}</legend>
      {RESPONSE_MODES.map((mode) => (
        <label key={mode} className={styles.whoAnswersOption}>
          <input
            type="radio"
            name="who-answers"
            checked={value === mode}
            data-testid={`connect-mode-${mode}`}
            onChange={() => onChange(mode)}
          />
          {t(`mode.${mode}` as 'mode.AI_AUTO_REPLY')}
        </label>
      ))}
    </fieldset>
  );
}

function Problem({ result }: { readonly result: ChannelWriteResult<unknown> }) {
  const t = useTranslations('channels');
  if (result.ok) return null;
  const message =
    result.reason === 'duplicate'
      ? t('connect.duplicate')
      : result.reason === 'limit'
        ? t('connect.limit')
        : result.reason === 'forbidden'
          ? t('connect.forbidden')
          : result.reason === 'invalid'
            ? (Object.values(result.fields)[0] ?? t('connect.failed'))
            : t('connect.failed');
  return (
    <p className={styles.connectProblem} data-testid="connect-problem">
      {message}
    </p>
  );
}

/** Instagram, Messenger, Gmail, Outlook, Slack: at the provider, and back to this list. */
function OAuthStep({ channel, name }: { readonly channel: ChannelType; readonly name: string }) {
  const t = useTranslations('channels.connect');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <p className={styles.connectNote}>{t('oauthLead', { channel: name })}</p>
      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          disabled={isPending}
          data-testid={`connect-oauth-${channel}`}
          onClick={() =>
            startTransition(async () => {
              setProblem(null);
              const start = await startChannelConnect(channel);
              if (start.ok) {
                window.location.assign(start.url);
                return;
              }
              setProblem(t(`start.${start.reason}`, { channel: name }));
            })
          }
        >
          {isPending ? t('opening') : t('continueTo', { channel: name })}
        </Button>
      </div>
      {problem ? (
        <p className={styles.connectProblem} role="alert" data-testid="connect-problem">
          {problem}
        </p>
      ) : null}
    </>
  );
}

/**
 * The web chat's embed code (the old app's snippet, HTML): identity only —
 * the widget id and where to load it from. Colours and words live in the
 * dashboard, not in a snippet pasted months ago.
 */
export function EmbedSnippet({
  widgetId,
  onClose,
}: {
  readonly widgetId: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('channels.embed');
  const [copied, setCopied] = useState<boolean | null>(null);
  const code = embedCode(widgetId, window.location.origin);
  return (
    <div data-testid="webchat-embed">
      <p className={styles.connectNote}>{t('lead')}</p>
      <pre className={styles.embedCode} data-testid="webchat-embed-code">
        {code}
      </pre>
      <div className={styles.connectActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="webchat-copy"
          onClick={() =>
            void navigator.clipboard
              .writeText(code)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? t('copied') : t('copy')}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t('done')}
        </Button>
      </div>
      {copied === false ? (
        <p className={styles.connectProblem} role="alert">
          {t('copyFailed')}
        </p>
      ) : null}
    </div>
  );
}

/** The snippet itself — pure, so the exact text is tested. */
export function embedCode(widgetId: string, apiUrl: string): string {
  // JSON, with `<` escaped: a value can never end the merchant's <script>.
  const literal = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const id = literal(widgetId);
  const api = literal(apiUrl);
  return [
    '<!-- GOTCHA chat -->',
    '<script>',
    '(function(){',
    `  window.__chatcenter = { widgetId: ${id}, apiUrl: ${api} };`,
    '  var s = document.createElement("script");',
    `  s.src = ${literal(`${apiUrl}/widget/chatcenter-widget.js`)};`,
    '  s.async = true;',
    '  document.head.appendChild(s);',
    '})();',
    '</script>',
  ].join('\n');
}
