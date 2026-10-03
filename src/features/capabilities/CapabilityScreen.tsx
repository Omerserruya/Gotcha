import { getTranslations } from 'next-intl/server';

import {
  automationCeiling,
  capabilityStance,
  groupByCategory,
  hasOwnWords,
  humaniseToolName,
  isTheAdminsChoice,
  isUniform,
  neverFailed,
  resolveAvailability,
  usageFor,
  type Capability,
  type ToolUsage,
} from '@/api/contracts/capabilities';

import { PermissionChoice } from './PermissionChoice';
import styles from './Capabilities.module.css';

/**
 * Screen 10 — what GOTCHA is allowed to do.
 *
 * ── SAID ONCE, NOT SEVENTEEN TIMES ──
 * `isDefault`, `allowModification`, `expiresAfterMin` and `approverRole` are
 * **uniform across every row on this tenant**. A column of identical values
 * reads as seventeen decisions somebody made; one sentence reads as what it
 * is — a platform default nobody has changed.
 *
 * ── AND NOT GROUPED BY RISK ──
 * `riskGroup` is a regex over the tool's name with `create_update` as its
 * no-match fallback, so grouping by it would present *"matched no pattern"*
 * as *"create/update risk"*. `category` is a stored field with six real
 * values, and that is what the screen groups by.
 */
export async function CapabilityScreen({
  capabilities,
  usage,
}: {
  readonly capabilities: readonly Capability[];
  /** `null` when the usage read failed or was not permitted. Never zeroes. */
  readonly usage: readonly ToolUsage[] | null;
}) {
  const t = await getTranslations('capabilities');

  const groups = groupByCategory(capabilities);

  const allDefault = isUniform(capabilities, (c) => c.isDefault) && capabilities[0]?.isDefault;
  const noEditing =
    isUniform(capabilities, (c) => c.allowModification) && !capabilities[0]?.allowModification;
  const sameExpiry = isUniform(capabilities, (c) => c.expiresAfterMin)
    ? (capabilities[0]?.expiresAfterMin ?? null)
    : null;
  const noApprover =
    isUniform(capabilities, (c) => c.approverRole) && capabilities[0]?.approverRole === null;

  return (
    <div className={styles.screen} data-testid="capability-screen">
      {groups.map((group) => (
        <section
          key={group.category}
          className={styles.group}
          data-testid={`group-${group.category}`}
        >
          <h2 className={styles.groupHeading}>
            {t(`category.${group.category}` as 'category.messaging')}
          </h2>

          <ul className={styles.capabilities}>
            {group.capabilities.map((capability) => {
              /*
               * Still used, for `data-stance` — a styling and test hook that
               * says which of the three the tool is on. Not dead: I removed
               * it as unused a moment ago and the attribute below is the
               * reader I had missed.
               */
              const stance = capabilityStance(capability);
              return (
                <li
                  key={capability.toolName}
                  className={styles.capability}
                  data-testid={`capability-${capability.toolName}`}
                  data-stance={stance}
                >
                  {/*
                    Our words, not the platform's. Its `description` is
                    written for whoever CALLS the tool — backticks,
                    "(autonomous bot only)", instructions to use
                    `schedule_followup` — and seventeen rows of that is an API
                    reference on a merchant's screen. An unmapped tool falls
                    back to its own name rather than to that prose.
                  */}
                  <span className={styles.what}>
                    {hasOwnWords(capability.toolName)
                      ? t(`tool.${capability.toolName}` as 'tool.send_message')
                      : humaniseToolName(capability.toolName)}
                  </span>
                  {/*
                    ════════════════════════════════════════════════════════
                    ★★ FOUR STATES, BECAUSE THE PLATFORM MODELS FOUR
                    ════════════════════════════════════════════════════════
                    The design asks for three — do it, ask me, never. The
                    platform adds `unavailable`: the switch is not the
                    admin's to press right now, with a reason saying why.

                    That fourth state is the difference between a row that
                    reads "never" and a row that reads "you cannot turn this
                    on until the integration is reconnected". The first
                    looks like a decision somebody made; the second is a
                    repair somebody can perform.

                    And the reason ORDER matters: a disconnected integration
                    outranks a missing scope, because granting a scope on a
                    provider that is not connected is work that cannot help.
                  */}
                  {/*
                    ★★ "USED 612 TIMES", AND WHAT WE CANNOT SAY AFTER IT.
                    The design prints "· never failed" beside the count.
                    `erroredCount === 0` does not support that: attempts
                    written before the platform recorded a failure reason land
                    in `unclassifiedFailureCount` and are deliberately NOT
                    counted as errors, because the service will not guess
                    whether they were refusals or breakages.

                    So the claim has three answers and the middle one is
                    silence — see `neverFailed`. A refusal is never reported
                    as a failure either: a tool a policy keeps stopping and a
                    tool that keeps breaking need opposite repairs.
                  */}
                  {(() => {
                    const ran = usageFor(capability.toolName, usage);
                    /*
                      02's line under every action. Without a run to count,
                      the state says what happens instead — never a number
                      nobody measured, never a zero over a failed read.
                    */
                    if (!ran || ran.executionCount === 0) {
                      return stance === 'on_its_own' ? null : (
                        <span className={styles.used} data-testid={`ran-${capability.toolName}`}>
                          {t(stance === 'ask_first' ? 'ran.toApprovals' : 'ran.off')}
                        </span>
                      );
                    }
                    const clean = neverFailed(ran);
                    return (
                      <span className={styles.used} data-testid={`used-${capability.toolName}`}>
                        {t('used', { count: ran.executionCount })}
                        {clean === true ? ` · ${t('neverFailed')}` : ''}
                        {clean === false && ran.erroredCount !== undefined
                          ? ` · ${t('failedTimes', { count: ran.erroredCount })}`
                          : ''}
                        {ran.refusedCount > 0
                          ? ` · ${t('refusedTimes', { count: ran.refusedCount })}`
                          : ''}
                      </span>
                    );
                  })()}
                  {(() => {
                    const availability = resolveAvailability(capability);
                    return isTheAdminsChoice(availability) ? (
                      <PermissionChoice capability={capability} />
                    ) : (
                      <span
                        className={styles.blocked}
                        data-reason={availability.reason}
                        data-testid={`blocked-${capability.toolName}`}
                      >
                        {availability.reason === 'missing_scope' &&
                        availability.missingScopes.length > 0
                          ? /*
                             ★ THE SCOPES BY NAME. "Permissions are missing"
                             sends somebody hunting; the list tells them what
                             to grant — the same rule as 04d's missing_scopes
                             panel.
                            */
                            t('blocked.missingScopesNamed', {
                              scopes: availability.missingScopes.join(', '),
                            })
                          : t(`blocked.${availability.reason}` as 'blocked.missing_scope')}
                      </span>
                    );
                  })()}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {/*
        02's violet card proposes a change ("You've approved 11 refunds… raise
        to ₪200"). Nothing proposes one yet: drawn in its shape.
      */}
      {/*
        Why "Do it" is greyed on some rows — said ONCE, here, and on the
        segment itself; never beside each of seventeen rows.
      */}
      {capabilities.some((capability) => automationCeiling(capability) !== null) ? (
        <p className={styles.ceiling} data-testid="ceiling-note">
          {t('choice.ceilingNote')}
        </p>
      ) : null}

      <section className={styles.suggest} data-testid="capability-suggest">
        <p className={styles.suggestBody}>{t('suggestNone')}</p>
      </section>

      {/*
        Four facts that are the same on every row. Stated once rather than
        painted as seventeen separate settings.
      */}
      <ul className={styles.uniform} data-testid="uniform-facts">
        {allDefault ? <li data-testid="all-default">{t('uniform.allDefault')}</li> : null}
        {noEditing ? <li data-testid="no-editing">{t('uniform.noEditing')}</li> : null}
        {sameExpiry !== null ? (
          <li data-testid="expiry">{t('uniform.expiry', { minutes: sameExpiry })}</li>
        ) : null}
        {noApprover ? <li data-testid="no-approver">{t('uniform.noApprover')}</li> : null}
      </ul>
    </div>
  );
}
