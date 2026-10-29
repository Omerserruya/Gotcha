import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

import {
  accountIds,
  accountLabel,
  advisoryChecks,
  blockingChecks,
  byAccount,
  numberCount,
  deliveryState,
  repliesStillFlow,
  templatesPaused,
  fixableHere,
  type HealthCheck,
  type AccountName,
  type NumbersResponse,
  type UnprofiledNumber,
  type WhatsAppNumber,
} from '@/api/contracts/whatsapp-numbers';

import { PrimaryNumber } from './PrimaryNumber';
import styles from './Channels.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';
import rowLink from '@/design-system/styles/row-link.module.css';

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
  connectable = false,
}: {
  readonly numbers: NumbersResponse | null;
  /** The server can launch Meta's Embedded Signup (13c). */
  readonly connectable?: boolean;
}) {
  const t = await getTranslations('channels.whatsapp');
  const locale = await getLocale();
  const timeZone = await getTimeZone();

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

  /*
    ★ Two business accounts are two separate WhatsApp accounts (Omer,
    2026-10-29): each row says which one it is on, and the rows are grouped
    by account. With one, the panel's line names it and the rows say nothing.
  */
  const severalAccounts = accountIds(numbers).length > 1;
  const choosing = numbers.primary !== null && numberCount(numbers) > 1;
  const labelOf = (n: { phoneNumber: string | null; name: string | null }) =>
    n.phoneNumber ?? n.name ?? t('aNumber');
  const primaryRow = [...numbers.data, ...numbers.unprofiled].find((n) => n.isPrimary);
  const placeOf = (n: WhatsAppNumber | UnprofiledNumber): Place => ({
    account: severalAccounts ? accountLabel(n) : null,
    choosing,
    isPrimary: n.isPrimary,
    channelAccountId: n.channelAccountId,
    label: labelOf(n),
    current: primaryRow ? labelOf(primaryRow) : null,
  });
  const rows = byAccount([
    ...numbers.data.map((n) => ({
      kind: 'profiled' as const,
      key: n.id,
      wabaId: n.wabaId,
      number: n,
    })),
    ...numbers.unprofiled.map((u) => ({
      kind: 'unprofiled' as const,
      key: u.channelAccountId,
      wabaId: u.wabaId,
      number: u,
    })),
  ]);

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
        {rows.map((row) =>
          row.kind === 'profiled' ? (
            <li key={row.key}>
              <NumberCard number={row.number} t={t} locale={locale} place={placeOf(row.number)} />
            </li>
          ) : (
            <li key={row.key}>
              <UnprofiledCard
                number={row.number}
                t={t}
                locale={locale}
                timeZone={timeZone}
                place={placeOf(row.number)}
              />
            </li>
          ),
        )}
        <li>
          <AddNumber t={t} connectable={connectable} />
        </li>
      </ul>
      {/* What "primary" means, once, and only while there is a choice to make. */}
      {choosing ? (
        <p className={styles.primaryNote} data-testid="whatsapp-primary-note">
          {t('primary.note')}
        </p>
      ) : null}
    </>
  );
}

/**
 * Where a number stands among the others: which business account it is on
 * (said only when there is more than one), and whether it is the primary
 * (drawn only when the server knows one and there are two numbers or more).
 */
interface Place {
  readonly account: AccountName | null;
  readonly choosing: boolean;
  readonly isPrimary: boolean;
  readonly channelAccountId: string | null;
  /** This number and the primary now, as their rows name them. */
  readonly label: string;
  readonly current: string | null;
}

/**
 * The panel's line under "WhatsApp": the business account by name and how
 * many numbers (02: "Aviv & Co. WhatsApp Business account · 2 numbers"); with
 * two accounts or more, how many of each. No name known: as before.
 */
export function WhatsAppLine({ numbers, t }: { readonly numbers: NumbersResponse; readonly t: T }) {
  const count = numberCount(numbers);
  const ids = accountIds(numbers);
  if (ids.length > 1) return <>{t('panelLineAccounts', { accounts: ids.length, count })}</>;
  const first = [...numbers.data, ...numbers.unprofiled].find((n) => n.wabaId === ids[0]);
  const name = first ? accountLabel(first) : null;
  if (name === null) return <>{t('panelLine', { count })}</>;
  return (
    <>
      {t.rich('panelLineAccount', {
        count,
        name: name.text,
        account: (chunks) => <AccountBdi name={name}>{chunks}</AccountBdi>,
      })}
    </>
  );
}

function NumberCard({
  number,
  t,
  locale,
  place,
}: {
  readonly number: WhatsAppNumber;
  readonly t: T;
  readonly locale: string;
  readonly place: Place;
}) {
  const delivery = deliveryState(number.health);
  const blocking = blockingChecks(number.health);
  const advisory = advisoryChecks(number.health);

  return (
    <article className={styles.number} data-testid="whatsapp-number" data-delivery={delivery}>
      <p className={styles.numberLine}>
        <NumberIdentity phone={number.phoneNumber} name={number.name} t={t} />
        <PrimaryChip place={place} t={t} />
      </p>
      <AccountLine place={place} t={t} />

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
      <NumberRows t={t} place={place} />
    </article>
  );
}

/** "Primary", first among the row's chips, while there is a choice. */
function PrimaryChip({ place, t }: { readonly place: Place; readonly t: T }) {
  return place.choosing && place.isPrimary ? (
    <span className={styles.chipQuiet} data-testid="whatsapp-primary-chip">
      {t('primary.chip')}
    </span>
  ) : null;
}

/** A name in its own direction; the `…last4` stand-in always left to right. */
function AccountBdi({
  name,
  children,
}: {
  readonly name: AccountName;
  readonly children: ReactNode;
}) {
  return <bdi dir={name.unnamed ? 'ltr' : 'auto'}>{children}</bdi>;
}

/** Which business account the number is on - only when there is more than one. */
function AccountLine({ place, t }: { readonly place: Place; readonly t: T }) {
  const account = place.account;
  return account ? (
    <p className={styles.numberAccount} data-testid="whatsapp-account">
      {t.rich('account', {
        name: account.text,
        account: (chunks) => <AccountBdi name={account}>{chunks}</AccountBdi>,
      })}
    </p>
  ) : null;
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
/**
 * The number, then its name - or, while Meta's number has not been read, the
 * name and a muted line saying so. Never the raw id: a sixteen-digit Meta id
 * reads as a broken phone number.
 */
function NumberIdentity({
  phone,
  name,
  t,
}: {
  readonly phone: string | null;
  readonly name: string | null;
  readonly t: T;
}) {
  if (phone) {
    return (
      <>
        <span className={styles.numberPhone}>
          <bdi dir="ltr">{phone}</bdi>
        </span>
        {name ? (
          <span className={styles.numberName}>
            <UserText>{name}</UserText>
          </span>
        ) : null}
      </>
    );
  }
  return (
    <>
      {name ? (
        <span className={styles.numberPhone}>
          <UserText>{name}</UserText>
        </span>
      ) : null}
      <span className={styles.numberName} data-testid="number-not-read">
        {t('phoneNotRead')}
      </span>
    </>
  );
}

function UnprofiledCard({
  number,
  t,
  locale,
  timeZone,
  place,
}: {
  readonly number: UnprofiledNumber;
  readonly t: T;
  readonly locale: string;
  readonly timeZone: string | undefined;
  readonly place: Place;
}) {
  /*
    02's number card, in its shape: the number over its state; then what is
    configured on it. Its raw `connectionStatus` is never printed.

    ★ What Meta last told us is shown (Omer, 2026-10-09): its quality, its
      verified name and when it was last read. Only with none of the three is
      it "No health data" - the chip that said so on every card.
  */
  const known =
    number.qualityRating !== null ||
    number.verifiedName !== null ||
    number.lastHealthCheck !== null;
  const checked = number.lastHealthCheck ? new Date(number.lastHealthCheck) : null;
  return (
    <article className={styles.number} data-testid="whatsapp-unprofiled">
      <div className={styles.numberHead}>
        <span className={styles.numberLine}>
          <NumberIdentity phone={number.phoneNumber} name={number.name} t={t} />
        </span>
        <span className={styles.numberChips}>
          <PrimaryChip place={place} t={t} />
          {number.qualityRating ? (
            <span
              className={styles.chipQuiet}
              data-quality={number.qualityRating}
              title={t('unprofiled.qualityWhy')}
              data-testid="whatsapp-quality"
            >
              {t(`unprofiled.quality.${number.qualityRating}`)}
            </span>
          ) : known ? null : (
            <span className={styles.chipQuiet} title={t('unprofiled.body')}>
              {t('unprofiled.noHealth')}
            </span>
          )}
        </span>
      </div>
      <AccountLine place={place} t={t} />
      {number.verifiedName ? (
        <p className={styles.lastChecked} data-testid="whatsapp-verified-name">
          {t('unprofiled.verifiedName')} <UserText>{number.verifiedName}</UserText>
        </p>
      ) : null}
      {checked && Number.isFinite(checked.getTime()) ? (
        <p className={styles.lastChecked} data-testid="whatsapp-last-checked">
          {t('lastChecked', {
            // 24-hour, in the workspace's zone, as the rest of the product writes a time.
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
              hourCycle: 'h23',
              timeZone,
            }).format(checked),
          })}
        </p>
      ) : null}
      <NumberRows t={t} place={place} />
    </article>
  );
}

/**
 * What is configured on a number: the hours (the workspace's). Who answers
 * is not the channel's (Omer, 2026-10-07): the automations and the playbook
 * decide it - said once, with the way there. "AI mode", "Answered by" and
 * "First greeting" were a field nothing read and two that did not exist.
 */
function NumberRows({ t, place }: { readonly t: T; readonly place: Place }) {
  return (
    <>
      <dl className={styles.numberRows}>
        {/* The whole row leads to Workspace, where the hours are set. */}
        <div className={rowLink.row}>
          <dt>{t('rows.hours')}</dt>
          <dd>
            {/* The workspace's hours apply; they are set on Workspace. */}
            <Link href="/settings/workspace" className={`${styles.numberLink} ${rowLink.link}`}>
              {t('rows.hoursWorkspace')}
            </Link>
          </dd>
        </div>
        {place.choosing ? (
          <div>
            <dt>{t('primary.rowLabel')}</dt>
            <dd>
              <PrimaryNumber
                channelAccountId={place.channelAccountId}
                isPrimary={place.isPrimary}
                phone={place.label}
                current={place.current}
              />
            </dd>
          </div>
        ) : null}
      </dl>
      <p className={styles.whoAnswersNote} data-testid="number-who-answers">
        {t.rich('rows.whoAnswers', {
          automations: (chunks) => (
            <Link href="/studio/automations" className={styles.numberLink}>
              {chunks}
            </Link>
          ),
        })}
      </p>
    </>
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
