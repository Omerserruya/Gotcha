import { getLocale, getTranslations } from 'next-intl/server';

import {
  advisoryChecks,
  blockingChecks,
  deliveryState,
  fixableHere,
  type HealthCheck,
  type NumbersResponse,
  type UnprofiledNumber,
  type WhatsAppNumber,
} from '@/api/contracts/whatsapp-numbers';

import styles from './Channels.module.css';

/**
 * The resolved translator and locale, passed down rather than re-fetched.
 *
 * The children used to be `async` and call `getTranslations` each — which is
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
 * WhatsApp numbers — screen 13.
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
 * default — which is what makes it the trap. Nothing here reads it.
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
export async function WhatsAppNumbers({ numbers }: { readonly numbers: NumbersResponse | null }) {
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
      <p className={styles.empty} data-testid="whatsapp-empty">
        {t('empty')}
      </p>
    );
  }

  return (
    <ul className={styles.numbers} data-testid="whatsapp-numbers">
      {numbers.data.map((n) => (
        <li key={n.id}>
          <NumberCard number={n} t={t} locale={locale} />
        </li>
      ))}
      {numbers.unprofiled.map((u) => (
        <li key={u.channelAccountId}>
          <UnprofiledCard number={u} t={t} />
        </li>
      ))}
    </ul>
  );
}

function NumberCard({
  number,
  t,
  locale,
}: {
  readonly number: WhatsAppNumber;
  readonly t: T;
  readonly locale: string;
}) {
  const delivery = deliveryState(number.health);
  const blocking = blockingChecks(number.health);
  const advisory = advisoryChecks(number.health);

  return (
    <article className={styles.number} data-testid="whatsapp-number" data-delivery={delivery}>
      <p className={styles.numberLine}>
        <span className={styles.numberPhone}>{number.phoneNumber ?? number.id}</span>
        {number.name ? <span className={styles.numberName}>{number.name}</span> : null}
      </p>

      {/*
        The verdict, in four values rather than two. `inbound_only` gets a
        sentence of its own: the half it IS doing is the half the customer's
        inbox depends on, and "needs attention" would bury that.
      */}
      <p className={styles.delivery} data-testid="whatsapp-delivery">
        {t(`delivery.${delivery}`)}
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
            translated — a paraphrase of a platform's fix instructions is a new
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
 * Connected and working, with **nothing known about it** — which is neither
 * healthy nor broken, and the card must not imply either. It states what is
 * true, says why there is nothing more, and offers no repair, because every
 * repair verb addresses a number record that does not exist.
 *
 * **On this tenant this is the only card that renders.**
 */
function UnprofiledCard({ number, t }: { readonly number: UnprofiledNumber; readonly t: T }) {
  return (
    <article className={styles.number} data-testid="whatsapp-unprofiled">
      <p className={styles.numberLine}>
        <span className={styles.numberPhone}>{number.name ?? number.phoneNumberId}</span>
      </p>
      <p className={styles.delivery}>{t('unprofiled.title')}</p>
      <p className={styles.deliveryDetail} data-testid="whatsapp-unprofiled-body">
        {/*
          Translated rather than rendered from the route's `note`, which ships
          in English only. The billing disclaimer is rendered verbatim because
          it ships translated AND is a commercial claim; this is an operational
          explanation with no Hebrew available, and English on the one card a
          Hebrew tenant can see is the worse of the two errors.
        */}
        {t('unprofiled.body')}
      </p>
      <p className={styles.lastChecked}>
        {t('unprofiled.status', { status: number.connectionStatus })}
      </p>
    </article>
  );
}
