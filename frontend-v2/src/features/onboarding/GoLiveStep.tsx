'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { EmployeeTest, GoLive } from '@/api/contracts/onboarding-v2';
import { channelName } from '@/api/contracts/inbox';
import { Input } from '@/design-system/primitives/input/Input';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { Link, useRouter } from '@/i18n/navigation';

import { askEmployee, goLive, type EmployeeTestResult, type GoLiveResult } from './live-actions';
import { inPlace } from './channel-reach';
import styles from './Onboarding.module.css';
import { stepHref } from './preview';
import { nameOf } from './ScanFeed';
import { saveStep } from './step-actions';

/** The warnings go-live answers with that are said; any other is not guessed at. */
const WARNINGS = [
  'no_channels',
  'no_reachable_channel',
  'no_platform_connected',
  'playbook_customized',
  'employee_customized',
] as const;
type Warning = (typeof WARNINGS)[number];
const isWarning = (value: string): value is Warning =>
  (WARNINGS as readonly string[]).includes(value);

/** A tool that reads an order or its shipment (the store's read tools, by name). */
const ORDER_TOOL = /order|shipment|tracking/i;

/**
 * Step 4's end: the one press that makes the first employee and puts it to
 * work, then one sandboxed question to see it answer.
 *
 * ★ Before the press it says plainly what happens: where the employee will
 *   answer (only channels a customer can write on now), or that it will be
 *   live but answering nowhere yet. The press sends nothing to anyone.
 * ★ After it, each channel says whether it answers there now or waits for
 *   install, as Backend found it; order tools are said as looking up orders,
 *   never more.
 * ★ The test runs in a sandbox: nothing is sent, no conversation is shown.
 *   It says when the answer came from a real order, and plainly when the
 *   order could not be read.
 */
export function GoLiveStep({
  reach,
  current,
  preview = false,
}: {
  /**
   * The channels a customer can write on now, as one phrase built on the
   * server ("the website and WhatsApp"); `''` none; `null` unread.
   */
  readonly reach: string | null;
  /** The employee go-live already made (GET /step); `null` before go-live. Pressing again updates it. */
  readonly current: { readonly name: string } | null;
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.goLive');
  const tn = useTranslations('onboarding');
  const alreadyLive = current !== null;
  // The current name, so the field never suggests a rename; an empty field keeps it (Backend 92196d5d).
  const [name, setName] = useState(current?.name ?? '');
  const [result, setResult] = useState<GoLiveResult | null>(null);
  const [isPending, start] = useTransition();
  const live = result?.ok ? result.live : null;
  const who = live?.employee.name || name.trim() || t('someone');
  const noReach = reach === '';

  const press = () =>
    start(async () => {
      setResult(await goLive(name).catch((): GoLiveResult => ({ ok: false, reason: 'failed' })));
    });

  return (
    <section className={styles.system} aria-label={t('title')} data-testid="go-live">
      <h2 className={styles.systemName}>{t('title')}</h2>

      {live ? (
        <Result live={live} payAt={result?.ok ? result.payAt : null} />
      ) : (
        <>
          {alreadyLive ? (
            <p className={styles.quiet} data-testid="go-live-again">
              {t('again', { name: current.name })}
            </p>
          ) : null}
          <Input
            dir="auto"
            label={t('nameLabel')}
            hint={alreadyLive ? t('nameHintLive') : t('nameHint')}
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isPending || preview}
          />
          {/* What the press does, before it: where it answers, or that it answers nowhere yet. */}
          <p className={styles.itemTitle} data-testid="go-live-what">
            {reach === null
              ? t('reachUnread', { name: who })
              : noReach
                ? t('noReach', { name: who })
                : t('willAnswer', { name: who, channels: reach })}
          </p>
          <p className={styles.quiet}>{t('nothingSent', { name: who })}</p>
          <span className={styles.actions}>
            {preview ? (
              <UnavailableAction
                label={t('press')}
                tag={tn('preview.tag')}
                why={tn('preview.why')}
              />
            ) : (
              <button
                type="button"
                className={styles.primary}
                onClick={press}
                disabled={isPending}
                data-testid="go-live-press"
              >
                {isPending
                  ? t('pressing')
                  : alreadyLive
                    ? t('pressAgain')
                    : noReach
                      ? t('pressNoReach')
                      : t('press')}
              </button>
            )}
            {noReach ? (
              <Link
                href={stepHref('/onboarding/channels', preview)}
                className={styles.secondary}
                data-testid="go-live-to-channels"
              >
                {t('toChannels')}
              </Link>
            ) : null}
          </span>
          {result && !result.ok ? (
            <p className={styles.problem} role="alert" data-testid="go-live-refused">
              {t(`refused.${result.reason}`)}
            </p>
          ) : null}
        </>
      )}

      {live || alreadyLive ? (
        <Test
          who={live?.employee.name ?? current?.name ?? null}
          suggested={live?.test.suggestedOrderQuestion ?? live?.test.suggestedQuestion ?? ''}
          preview={preview}
        />
      ) : null}
      {live || alreadyLive ? <Finish preview={preview} /> : null}
    </section>
  );
}

/** What went live: the employee, where it answers now, what it can do, and what to know. */
function Result({ live, payAt }: { readonly live: GoLive; readonly payAt: string | null }) {
  const t = useTranslations('onboarding.goLive');
  const tc = useTranslations('channels');
  const locale = useLocale();
  const name = live.employee.name;
  const warnings = live.warnings.filter(isWarning);
  return (
    <div className={styles.connectHere} data-testid="go-live-done">
      {/* Set up but unpaid: ready, answering no one until payment clears - never "live". */}
      {live.paymentRequired ? (
        <>
          <p className={styles.itemTitle} role="status" data-testid="go-live-awaiting-payment">
            {t('ready', { name })}
          </p>
          {payAt ? (
            <span className={styles.actions}>
              <a href={payAt} className={styles.primary} data-testid="go-live-pay">
                {t('toPayment')}
              </a>
            </span>
          ) : null}
        </>
      ) : (
        <p className={styles.itemTitle} role="status">
          {t('live', { name })}
        </p>
      )}
      {live.channels.length && !live.paymentRequired ? (
        <ul className={styles.terms} data-testid="go-live-channels">
          {live.channels.map((channel) => (
            <li key={channel.id} data-testid={`go-live-channel-${channel.id}`}>
              {/* The channel by its kind ("WhatsApp"): an account's name is often the business's own. */}
              <bdi dir="auto">{channelName(channel.type, tc) ?? channel.displayName}</bdi>
              {': '}
              {channel.reach === 'live' ? t('reachLive') : t('reachWaiting')}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Read tools only: it looks orders up, never changes them. */}
      {live.tools.platform && live.tools.granted.length ? (
        <p className={styles.quiet} data-testid="go-live-orders">
          {t('orders', { name, inPlatform: inPlace(nameOf(live.tools.platform), locale) })}
        </p>
      ) : null}
      {warnings.map((warning) => (
        <p key={warning} className={styles.why} data-testid={`go-live-warning-${warning}`}>
          {t(`warn.${warning}`, { name })}
        </p>
      ))}
    </div>
  );
}

/** One question to the live employee, in a sandbox: nothing is sent to anyone. */
function Test({
  who,
  suggested,
  preview,
}: {
  /** The employee's name; `null` after a reload, when only the step says it is live. */
  readonly who: string | null;
  readonly suggested: string;
  readonly preview: boolean;
}) {
  const t = useTranslations('onboarding.goLive.test');
  const tg = useTranslations('onboarding.goLive');
  const name = who ?? tg('someone');
  const [question, setQuestion] = useState(suggested);
  const [result, setResult] = useState<EmployeeTestResult | null>(null);
  const [isPending, start] = useTransition();
  const ask = () => {
    if (!question.trim() || isPending) return;
    start(async () => {
      setResult(
        await askEmployee(question).catch((): EmployeeTestResult => ({
          ok: false,
          reason: 'failed',
        })),
      );
    });
  };
  return (
    <form
      className={styles.addMissing}
      onSubmit={(event) => {
        event.preventDefault();
        ask();
      }}
      data-testid="go-live-test"
    >
      <p className={styles.itemTitle}>{who ? t('title', { name: who }) : t('titleNoName')}</p>
      <p className={styles.quiet}>{t('lead')}</p>
      <Input
        dir="auto"
        label={t('question')}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        maxLength={300}
        disabled={preview}
      />
      <span className={styles.actions}>
        <button
          type="submit"
          className={styles.primary}
          disabled={preview || isPending || !question.trim()}
          data-testid="go-live-ask"
        >
          {isPending ? t('asking') : t('ask')}
        </button>
      </span>
      {result?.ok ? <Answer test={result.test} /> : null}
      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid="go-live-test-refused">
          {result.reason === 'rate_limited'
            ? result.retryAfterSeconds
              ? t('refused.rate_limited', { seconds: result.retryAfterSeconds })
              : t('refused.rate_limited_soon')
            : t(`refused.${result.reason}`, { name })}
        </p>
      ) : null}
    </form>
  );
}

/** The answer, and where it came from: a real order, an order it couldn't read, or what was learned. */
function Answer({ test }: { readonly test: EmployeeTest }) {
  const t = useTranslations('onboarding.goLive.test');
  const locale = useLocale();
  // Said only when no order number came back ("from order #N" is checked first).
  const orderFailed = test.toolsUsed.some((tool) => !tool.ok && ORDER_TOOL.test(tool.name));
  const titles = test.sources.map((source) => source.title).filter(Boolean);
  return (
    <div className={styles.connectHere} data-testid="go-live-answer">
      <p className={styles.answer}>
        <bdi dir="auto">{test.answer}</bdi>
      </p>
      {test.orderNumber ? (
        <p className={styles.connected} data-testid="go-live-from-order">
          {test.platform
            ? t('fromOrder', {
                number: test.orderNumber,
                inPlatform: inPlace(nameOf(test.platform), locale),
              })
            : t('fromOrderNoPlatform', { number: test.orderNumber })}
        </p>
      ) : orderFailed ? (
        <p className={styles.why} data-testid="go-live-order-unread">
          {t('orderUnread')}
        </p>
      ) : titles.length ? (
        <p className={styles.quiet} data-testid="go-live-from-knowledge">
          {t('fromKnowledge', { sources: titles.join(' · ') })}
        </p>
      ) : null}
    </div>
  );
}

/** Onboarding is done: the step is saved, then home. */
function Finish({ preview }: { readonly preview: boolean }) {
  const t = useTranslations('onboarding.goLive');
  const router = useRouter();
  const [isPending, start] = useTransition();
  return (
    <span className={styles.actions}>
      <button
        type="button"
        className={styles.secondary}
        disabled={preview || isPending}
        onClick={() =>
          start(async () => {
            await saveStep('done').catch(() => false);
            router.push('/home');
          })
        }
        data-testid="go-live-finish"
      >
        {t('finish')}
      </button>
    </span>
  );
}
