import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import {
  advisoryChecks,
  blockingChecks,
  deliveryState,
  repliesStillFlow,
  templatesPaused,
  fixableHere,
  type HealthCheck,
  type NumbersResponse,
  type UnprofiledNumber,
  type WhatsAppNumber,
} from '@/api/contracts/whatsapp-numbers';

import styles from './Channels.module.css';
import { ModeSwitch } from './ModeSwitch';
import { UserText } from '@/design-system/primitives/text/UserText';

/**
 * The resolved translator and locale, passed down rather than re-fetched.
 *
 * The children used to be `async` and call `getTranslations` each - which is
 * one await per number, and, more to the point, makes them async CHILD
 * components. React cannot resolve those outside a server renderer, so the
 * whole subtree was untestable: `render(await WhatsAppNumbers(...))` produced
 * an empty body and every assertion failed identically, whatever was wrong.
 *
 * Resolving once at the top makes the children ordinary functions, and the
 * card branches become reachable by a test.
 */
type T = Awaited<ReturnType<typeof getTranslations<'channels.whatsapp'>>>;

/**
 * WhatsApp numbers - screen 13.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * "IS IT WORKING" HAS FOUR ANSWERS, AND `ready` GIVES TWO
 * ════════════════════════════════════════════════════════════════════════════
 * The report carries `receiving` and `sending` as separate booleans because
 * they fail separately, and the platform's comment records what collapsing
 * them cost:
 *
 * > *"A number that receives customer messages IS connected and IS doing work,
 * > even while Meta blocks outbound over a billing problem on the WABA.
 * > Folding both into one verdict reported that number as '0 working, 1 needs
 * > attention' to a customer whose inbox was filling up."*
 *
 * `ready` is in the same object, and it is the field a card binds to by
 * default - which is what makes it the trap. Nothing here reads it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE PLACES A PROBLEM CAN BE FIXED, AND THE SCREEN SAYS WHICH
 * ════════════════════════════════════════════════════════════════════════════
 * `availableRepairs` we can run · `needsRegistration` the customer can run
 * HERE · `customerActions` only in Meta. The middle one has its own flag
 * precisely because it is the one blocked state clearable from inside GOTCHA,
 * and folding it into the third would send somebody to Meta's settings for
 * the one thing they could have done in two clicks.
 *
 * And no control is drawn for the third, because *"offering one and having it
 * fail is worse than saying plainly that this one is theirs to fix."*
 */
export async function WhatsAppNumbers({
  numbers,
  responseModes = {},
  connectable = false,
}: {
  readonly numbers: NumbersResponse | null;
  /** The server can launch Meta's Embedded Signup (13c). */
  readonly connectable?: boolean;
  /** Who answers each channel account (13b's "AI mode"), from the channel list. */
  readonly responseModes?: Readonly<Record<string, string>>;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();

  if (numbers === null) {
    return (
      <p className={styles.unavailable} data-testid="whatsapp-unavailable">
        {/*
          A failed read is not an empty list. "You have no WhatsApp numbers" is
          a statement about the workspace; this is a statement about us.
        */}
        {t('unavailable')}
      </p>
    );
  }

  if (numbers.data.length === 0 && numbers.unprofiled.length === 0) {
    return (
      <>
        <p className={styles.empty} data-testid="whatsapp-empty">
          {t('empty')}
        </p>
        <AddNumber t={t} connectable={connectable} />
      </>
    );
  }

  /*
    ★ ABOVE THE LIST, BECAUSE IT IS ABOUT THE BUSINESS AND NOT ABOUT A ROW.
    ════════════════════════════════════════════════════════════════════════
    Meta reports `can_send_message` per entity, and MESSAGE_TEMPLATE is its
    own. So a number can be taking customer messages and answering them inside
    the 24-hour window while every reminder, cart recovery and campaign is
    refused - `receiving`/`sending` one level finer, and the state Omer asked
    to be warned about by name.

    Only numbers with a lifecycle row can report it; an unprofiled channel has
    no health at all, so it contributes nothing here rather than a false all-
    clear.
  */
  const paused = numbers.data
    .map((n) => ({ number: n, block: templatesPaused(n.health) }))
    .filter(
      (
        x,
      ): x is { number: WhatsAppNumber; block: NonNullable<ReturnType<typeof templatesPaused>> } =>
        x.block !== null,
    );

  return (
    <>
      {paused.length > 0 ? (
        <section className={styles.templatesPaused} data-testid="templates-paused">
          <p className={styles.templatesPausedTitle}>{t('templatesPaused.title')}</p>
          <p className={styles.templatesPausedBody}>{t('templatesPaused.body')}</p>

          {/*
            The sentence that stops this reading as "WhatsApp is down", and it
            is gated on the number actually receiving rather than stated as a
            general fact about WhatsApp - because it is only true while it is.
          */}
          {paused.some((x) => repliesStillFlow(x.number.health)) ? (
            <p className={styles.templatesPausedBody} data-testid="templates-paused-replies">
              {t('templatesPaused.repliesStillFlow')}
            </p>
          ) : null}

          {/*
            Meta's words, verbatim. The design's copy asserts "no payment
            method", which is ONE cause among several - quality ratings and
            policy violations pause templates too. We report the block, which
            we know, and quote Meta for the cause, which they know and we do
            not.
          */}
          <p className={styles.templatesPausedReason} data-testid="templates-paused-reason">
            {paused[0]!.block.reason ?? t('templatesPaused.noReason')}
          </p>
          {paused[0]!.block.solution ? (
            <p className={styles.metaSolution} data-testid="templates-paused-solution">
              {paused[0]!.block.solution}
            </p>
          ) : null}

          {/* No button: this screen connects nothing and repairs nothing. */}
          <p className={styles.templatesPausedBody}>{t('templatesPaused.fixInMeta')}</p>
        </section>
      ) : null}

      <ul className={styles.numbers} data-testid="whatsapp-numbers">
        {numbers.data.map((n) => (
          <li key={n.id}>
            <NumberCard
              number={n}
              t={t}
              locale={locale}
              mode={n.channelAccountId ? (responseModes[n.channelAccountId] ?? null) : null}
            />
          </li>
        ))}
        {numbers.unprofiled.map((u) => (
          <li key={u.channelAccountId}>
            <UnprofiledCard number={u} t={t} mode={responseModes[u.channelAccountId] ?? null} />
          </li>
        ))}
        <li>
          <AddNumber t={t} connectable={connectable} />
        </li>
      </ul>
    </>
  );
}

function NumberCard({
  number,
  t,
  locale,
  mode,
}: {
  readonly number: WhatsAppNumber;
  readonly t: T;
  readonly locale: string;
  readonly mode: string | null;
}) {
  const delivery = deliveryState(number.health);
  const blocking = blockingChecks(number.health);
  const advisory = advisoryChecks(number.health);

  return (
    <article className={styles.number} data-testid="whatsapp-number" data-delivery={delivery}>
      <p className={styles.numberLine}>
        <span className={styles.numberPhone}>
          <bdi dir="ltr">{number.phoneNumber ?? number.id}</bdi>
        </span>
        {number.name ? <span className={styles.numberName}>{number.name}</span> : null}
      </p>

      {/*
        The verdict, in four values rather than two. `inbound_only` gets a
        sentence of its own: the half it IS doing is the half the customer's
        inbox depends on, and "needs attention" would bury that.
      */}
      <p className={styles.delivery} data-testid="whatsapp-delivery">
        {t(`delivery.${delivery}`)}
        {/*
          The per-number badge the design puts on the row. A number can be
          "sending and receiving" for ordinary replies AND have its templates
          paused, so this sits beside the verdict rather than replacing it.
        */}
        {templatesPaused(number.health) ? (
          <span className={styles.templatesBadge} data-testid="whatsapp-templates-badge">
            {t('templatesPaused.badge')}
          </span>
        ) : null}
      </p>
      {delivery === 'inbound_only' ? (
        <p className={styles.deliveryDetail} data-testid="whatsapp-delivery-detail">
          {t('delivery.inboundOnlyDetail')}
        </p>
      ) : delivery === 'outbound_only' ? (
        <p className={styles.deliveryDetail} data-testid="whatsapp-delivery-detail">
          {t('delivery.outboundOnlyDetail')}
        </p>
      ) : null}

      {blocking.length > 0 ? (
        <section data-testid="whatsapp-blocking">
          <h3 className={styles.checkHeading}>{t('blocking')}</h3>
          <CheckList checks={blocking} t={t} />
        </section>
      ) : null}

      {advisory.length > 0 ? (
        <section data-testid="whatsapp-advisory">
          {/*
            Kept, and kept SEPARATE. Without the split "an unregistered number
            sat in the same flat list as a SIP calling notice, and the customer
            could not tell which one was the reason nothing worked."
          */}
          <h3 className={styles.checkHeading}>{t('advisory')}</h3>
          <CheckList checks={advisory} t={t} />
        </section>
      ) : null}

      {fixableHere(number.health) ? (
        <section className={styles.fixHere} data-testid="whatsapp-register">
          <h3 className={styles.checkHeading}>{t('register.title')}</h3>
          <p className={styles.checkDetail}>{t('register.body')}</p>
        </section>
      ) : null}

      {number.health.availableRepairs.length > 0 ? (
        <section data-testid="whatsapp-repairs">
          <h3 className={styles.checkHeading}>{t('repair.title')}</h3>
          <ul className={styles.repairs}>
            {number.health.availableRepairs.map((r) => (
              <li key={r} className={styles.repair} data-testid="whatsapp-repair">
                {t(`repair.${r}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {number.health.customerActions.length > 0 ? (
        <section className={styles.theirs} data-testid="whatsapp-customer-actions">
          {/*
            Named, never actioned. Every one of these is resolved in Meta's own
            settings, and a button here would be one that cannot work.
          */}
          <h3 className={styles.checkHeading}>{t('customerActions.title')}</h3>
          <p className={styles.checkDetail}>{t('customerActions.body')}</p>
          <CheckList checks={number.health.customerActions} t={t} />
        </section>
      ) : null}

      <p className={styles.lastChecked} data-testid="whatsapp-last-checked">
        {number.health.lastCheckedAt
          ? t('lastChecked', {
              date: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
                new Date(number.health.lastCheckedAt),
              ),
            })
          : t('neverChecked')}
      </p>
      <NumberRows t={t} mode={mode} channelAccountId={number.channelAccountId} />
    </article>
  );
}

function CheckList({ checks, t }: { readonly checks: readonly HealthCheck[]; readonly t: T }) {
  return (
    <ul className={styles.checks}>
      {checks.map((c) => (
        <li key={c.id} className={styles.check} data-testid="whatsapp-check" data-status={c.status}>
          <span className={styles.checkLabel}>{c.label}</span>
          {c.status === 'UNKNOWN' ? (
            <span className={styles.checkDetail}>{t('checkUnknown')}</span>
          ) : null}
          {c.detail ? <span className={styles.checkDetail}>{c.detail}</span> : null}
          {/*
            Meta's own remediation text, VERBATIM. Never rewritten and never
            translated - a paraphrase of a platform's fix instructions is a new
            instruction nobody tested.
          */}
          {c.metaSolution ? (
            <span className={styles.metaSolution} data-testid="whatsapp-meta-solution">
              {c.metaSolution}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A WhatsApp channel with no lifecycle row.
 *
 * Connected and working, with **nothing known about it** - which is neither
 * healthy nor broken, and the card must not imply either. It states what is
 * true, says why there is nothing more, and offers no repair, because every
 * repair verb addresses a number record that does not exist.
 *
 * **On this tenant this is the only card that renders.**
 */
function UnprofiledCard({
  number,
  t,
  mode,
}: {
  readonly number: UnprofiledNumber;
  readonly t: T;
  readonly mode: string | null;
}) {
  /*
    02's number card, in its shape: the number over its state; then what is
    configured on it. A number set up before per-number health existed has
    no health data - said as a grey chip, not a paragraph - and its raw
    `connectionStatus` is never printed.
  */
  return (
    <article className={styles.number} data-testid="whatsapp-unprofiled">
      <div className={styles.numberHead}>
        <span className={styles.numberPhone}>
          {number.name ? (
            <UserText>{number.name}</UserText>
          ) : (
            <bdi dir="ltr">{number.phoneNumberId}</bdi>
          )}
        </span>
        <span className={styles.numberChips}>
          <span className={styles.chipQuiet} title={t('unprofiled.body')}>
            {t('unprofiled.noHealth')}
          </span>
        </span>
      </div>
      <NumberRows t={t} mode={mode} channelAccountId={number.channelAccountId} />
    </article>
  );
}

/** What is configured on a number - 02's four rows; "-" where nothing stores it. */
function NumberRows({
  t,
  mode,
  channelAccountId,
}: {
  readonly t: T;
  readonly mode: string | null;
  readonly channelAccountId: string | null;
}) {
  return (
    <dl className={styles.numberRows}>
      <div>
        <dt>{t('rows.answeredBy')}</dt>
        {/* A channel account has no AI employee or team of its own. */}
        <dd>-</dd>
      </div>
      <div>
        <dt>{t('rows.aiMode')}</dt>
        <dd data-testid="number-ai-mode">
          {/* 02's two segments, live - where the account and its mode are known. */}
          {channelAccountId && (mode === 'AI_AUTO_REPLY' || mode === 'HUMAN_WITH_COPILOT') ? (
            <ModeSwitch channelAccountId={channelAccountId} current={mode} />
          ) : mode === 'AI_AUTO_REPLY' || mode === 'HUMAN_WITH_COPILOT' ? (
            t(`rows.mode.${mode}`)
          ) : (
            '-'
          )}
        </dd>
      </div>
      <div>
        <dt>{t('rows.greeting')}</dt>
        <dd>-</dd>
      </div>
      <div>
        <dt>{t('rows.hours')}</dt>
        <dd>
          {/* The workspace's hours apply; they are set on Workspace. */}
          <Link href="/settings/workspace" className={styles.numberLink}>
            {t('rows.hoursWorkspace')}
          </Link>
        </dd>
      </div>
    </dl>
  );
}

/**
 * 02's dashed "Add another number" at the foot of the list - where 13c
 * starts: it opens the Connect WhatsApp sheet. Only the sheet's "Continue
 * with Meta" opens Meta. Not set up on the server: drawn, with why.
 */
function AddNumber({ t, connectable }: { readonly t: T; readonly connectable: boolean }) {
  return connectable ? (
    <Link
      href="/settings/channels?panel=whatsapp&view=connect"
      className={styles.addNumber}
      data-testid="whatsapp-add-number"
    >
      {t('addNumber')}
    </Link>
  ) : (
    <span
      className={styles.addNumber}
      aria-disabled="true"
      title={t('wizard.problem.notConfigured')}
      data-testid="whatsapp-add-number"
    >
      {t('addNumber')}
    </span>
  );
}
