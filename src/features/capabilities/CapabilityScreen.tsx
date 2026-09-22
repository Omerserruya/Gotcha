import { getTranslations } from 'next-intl/server';

import {
  actsAlone,
  capabilityStance,
  groupByCategory,
  isUniform,
  type Capability,
} from '@/api/contracts/capabilities';

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
}: {
  readonly capabilities: readonly Capability[];
}) {
  const t = await getTranslations('capabilities');

  const alone = actsAlone(capabilities);
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
      {/*
        The headline a reader needs first: how many act without asking. The
        design's three settings are real — "never" is disabled, "ask me
        first" is requiresApproval, "on its own" is neither.
      */}
      <p className={styles.summary} data-testid="acts-alone">
        {t('summary', { alone: alone.length, total: capabilities.length })}
      </p>

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
              const stance = capabilityStance(capability);
              return (
                <li
                  key={capability.toolName}
                  className={styles.capability}
                  data-testid={`capability-${capability.toolName}`}
                  data-stance={stance}
                >
                  <span className={styles.what}>
                    {capability.description || capability.toolName}
                  </span>
                  <span className={styles.stance} data-testid={`stance-${capability.toolName}`}>
                    {t(`stance.${stance}` as 'stance.ask_first')}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
