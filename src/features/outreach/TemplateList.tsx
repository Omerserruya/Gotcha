import { getTranslations } from 'next-intl/server';

import { groupByName, isUnchanged, templateStance, type Template } from '@/api/contracts/templates';

import styles from './Outreach.module.css';

/**
 * Screen 05c — message templates.
 *
 * ── THE SCREEN IS THE REJECTION REASON ──
 * `rejectionReason` is the provider's own words and it is real. That is the
 * one thing here worth building a screen around, in the same way that
 * *"approved but never ran"* was screen 03's.
 *
 * **Without an ETA.** Nothing models how long a review takes, so *"Being
 * reviewed · 1 day"* is a number with no source — the state is real, the
 * duration is not. And **without a rewrite**: nothing proposes a fix, so
 * *"GOTCHA rewrote it"* would be a claim about work that does not happen.
 *
 * ── FIVE ROW STATES, NOT THREE ──
 * The design draws ready / reviewing / rejected. The platform has four
 * statuses, and `DRAFT` — written and never submitted — is real, common, and
 * has no row in the design.
 *
 * The fifth is not a status at all. A template bound to `EMAIL` has **no
 * reviewer**, so it says why it needs no approval rather than sitting beside
 * "ready" as though somebody granted one.
 */
export async function TemplateList({ templates }: { readonly templates: readonly Template[] }) {
  const t = await getTranslations('templates');
  const groups = groupByName(templates);

  return (
    <div className={styles.templates} data-testid="template-list">
      <ul className={styles.templateRows}>
        {groups.map((group) => {
          const stance = templateStance(group.primary);
          return (
            <li
              key={group.name}
              className={styles.templateRow}
              data-testid={`template-${group.primary.id}`}
              data-stance={stance}
            >
              <div className={styles.templateHead}>
                <span className={styles.templateName}>{group.name}</span>
                {/*
                  Languages gathered from separate rows sharing this name —
                  `@@unique([tenantId, name, language, channel])`. There is no
                  translations field; this is a grouping.
                */}
                {group.languages.length > 0 ? (
                  <span
                    className={styles.templateLangs}
                    data-testid={`languages-${group.primary.id}`}
                  >
                    {group.languages.join(' · ')}
                  </span>
                ) : null}
              </div>

              <p className={styles.templateBody}>{group.primary.body}</p>

              <p className={styles.templateState} data-testid={`stance-${group.primary.id}`}>
                {t(`stance.${stance}` as 'stance.ready')}
              </p>

              {/*
                The provider's own words, shown as theirs. No ETA beside it,
                and no rewrite under it — neither exists.
              */}
              {stance === 'rejected' && group.primary.rejectionReason ? (
                <p className={styles.templateReason} data-testid={`reason-${group.primary.id}`}>
                  {t('rejectedBecause', { reason: group.primary.rejectionReason })}
                </p>
              ) : null}

              {stance === 'ready' && isUnchanged(group.primary) ? (
                <p className={styles.templateMeta} data-testid={`unchanged-${group.primary.id}`}>
                  {t('unchanged')}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
