import { getLocale, getTranslations } from 'next-intl/server';

import type { Integration, ToolPermission } from '@/api/contracts/integrations';

import { CapabilityControls } from './CapabilityControls';
import { buildSystemRows, messageOf, stanceCounts, type SystemRow } from './rows';
import styles from './Systems.module.css';

/**
 * Settings · Business systems — the banner, the list, and what each can do.
 *
 * A server component. The whole screen is read-only: the one action the design
 * draws is Reconnect, and on this tenant the only system is OAuth, which
 * cannot be re-authorised from here. See `repairableHere`.
 *
 * **The banner is not "integration down".** It is what is broken, since when,
 * and in the platform's own words. What it does NOT say is that anything is
 * being held: the design's *"11 exchange requests are waiting — GOTCHA is
 * holding them rather than guessing"* describes custodianship the product does
 * not perform. A tool call against a dead integration is attempted and fails.
 * There is no queue, nothing to release on recovery, and no state meaning
 * "waiting on Shopify". Dropping the number and keeping the sentence would
 * still promise custodianship, just vaguely — so the sentence goes too.
 */
export async function SystemsList({
  integrations,
  permissions,
  policyLoaded,
}: {
  readonly integrations: readonly Integration[];
  readonly permissions: readonly ToolPermission[];
  readonly policyLoaded: boolean;
}) {
  const t = await getTranslations('systems');
  const locale = await getLocale();
  const rows = buildSystemRows(integrations, permissions, policyLoaded, locale);
  const failing = rows.filter((row) => row.failing);

  if (rows.length === 0) {
    return <p className={styles.empty}>{t('empty')}</p>;
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div className={styles.screen}>
      {failing.map((row) => (
        <section
          key={`banner-${row.id}`}
          className={styles.banner}
          data-testid={`banner-${row.slug}`}
        >
          <p className={styles.bannerLead}>
            {row.lastCheckedAt
              ? t('banner.since', {
                  system: row.name,
                  date: day.format(new Date(row.lastCheckedAt)),
                })
              : t('banner.failing', { system: row.name })}
          </p>
          {/*
            The platform's own words. A paraphrase would be a second, vaguer
            copy of a message it already wrote, and this one names the cause:
            a token refresh returned 401.
          */}
          {row.error ? (
            <code className={styles.bannerError} data-testid={`banner-error-${row.slug}`}>
              {messageOf(row.error)}
            </code>
          ) : null}
          {/*
            Reconnect exists only where it can happen. An OAuth system is
            repaired by re-authorising at the provider, and that handshake
            returns to whichever app FRONTEND_URL names — not this one. So the
            banner says so rather than offering a button that starts something
            real and abandons the person in a different product.
          */}
          <p className={styles.bannerAction} data-testid={`banner-action-${row.slug}`}>
            {row.repairableHere
              ? t('banner.repairable')
              : t('banner.notRepairableHere', { system: row.name })}
          </p>
        </section>
      ))}

      <ul className={styles.list} data-testid="systems-list">
        {rows.map((row) => (
          <SystemEntry key={row.id} row={row} t={t} />
        ))}
      </ul>
    </div>
  );
}

function SystemEntry({
  row,
  t,
}: {
  readonly row: SystemRow;
  readonly t: Awaited<ReturnType<typeof getTranslations<'systems'>>>;
}) {
  const counts = stanceCounts(row);

  return (
    <li
      className={[styles.row, row.failing ? styles.rowFailing : ''].join(' ').trim()}
      data-testid={`system-${row.slug}`}
      data-failing={row.failing ? 'yes' : 'no'}
    >
      <div className={styles.head}>
        <span className={styles.name}>{row.name}</span>
        <span
          className={[styles.status, row.failing ? styles.statusBad : styles.statusGood]
            .join(' ')
            .trim()}
          data-testid={`system-status-${row.slug}`}
        >
          {row.failing ? t('state.failing') : t('state.working')}
        </span>
      </div>

      {row.description ? <p className={styles.description}>{row.description}</p> : null}

      {/*
        A capability can only run when the system is CONNECTED — that is a
        clause in the runtime's own tool-surface query, not an inference. So a
        broken system's capabilities are all inert however they are configured,
        and saying so once at the system level is more honest than relabelling
        sixty-eight rows.
      */}
      {!row.capabilitiesRunning ? (
        <p className={styles.notRunning} data-testid={`not-running-${row.slug}`}>
          {t('notRunning')}
        </p>
      ) : null}

      {/*
        "What it can do", and the reason this screen reads a second endpoint.

        The stance comes from the tenant's POLICY, not from whether the tool is
        activated. On this tenant those disagree: Process Refund is activated
        and policy-disabled, so rendering the activation would tell an owner
        the AI may issue refunds when they have switched that off.

        Capabilities are named in the words the catalogue uses — "Process
        Refund", "Add order note" — never as scopes. The API does not deal in
        scopes here, so the rule costs nothing to keep.
      */}
      <div className={styles.capabilities} data-testid={`capabilities-${row.slug}`}>
        {counts.unknown > 0 ? (
          // The policy read failed. We do not know what these may do, and
          // saying "Allowed" would be a guess in the reassuring direction.
          <span className={styles.stanceUnknown} data-testid={`stance-unknown-${row.slug}`}>
            {t('stance.unknown')}
          </span>
        ) : (
          <>
            <span className={styles.stanceAllow} data-testid={`stance-allow-${row.slug}`}>
              {t('stance.allow', { count: counts.allow })}
            </span>
            {counts.ask > 0 ? (
              <span className={styles.stanceAsk} data-testid={`stance-ask-${row.slug}`}>
                {t('stance.ask', { count: counts.ask })}
              </span>
            ) : null}
            {counts.never > 0 ? (
              <span className={styles.stanceNever} data-testid={`stance-never-${row.slug}`}>
                {t('stance.never', { count: counts.never })}
              </span>
            ) : null}
          </>
        )}
      </div>

      {/*
        The ones a person most needs to see by name are the ones turned OFF:
        "Allowed" is the default expectation, "Never" is the decision somebody
        made. Listing those explicitly is what makes the panel auditable.
      */}
      {row.capabilities.some((c) => c.stance === 'never' || c.stance === 'ask') ? (
        <ul className={styles.restricted} data-testid={`restricted-${row.slug}`}>
          {row.capabilities
            .filter((c) => c.stance === 'never' || c.stance === 'ask')
            .map((capability) => (
              <li key={capability.id} className={styles.restrictedItem}>
                <span>{capability.name}</span>
                <span className={styles.restrictedStance}>
                  {capability.stance === 'ask' ? t('stance.askOne') : t('stance.neverOne')}
                </span>
              </li>
            ))}
        </ul>
      ) : null}

      {/*
        Screen 14d, BELOW the counts and the restricted list, because those
        two answer the questions people actually arrive with — "what can it
        do" and "what did we switch off". This is the full audit surface, and
        it is collapsed.
      */}
      <CapabilityControls row={row} t={t} />
    </li>
  );
}
