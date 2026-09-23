import { getTranslations } from 'next-intl/server';

import { additions, removals, type Person } from '@/api/contracts/roles';

import styles from './Roles.module.css';

/**
 * Screen 12d — one person.
 *
 * ── ADDITIONS AND REMOVALS, SIDE BY SIDE ──
 * The design lists *"extra permissions… with who added them and when they
 * end"*. `UserFeatureGrant.granted` is a boolean and **`false` is a real,
 * settable revoke** — it takes away something the person's role gives.
 *
 * **A removal is invisible by construction.** The roles screen shows Agent
 * allowing refunds, this person is listed as an Agent, and this person cannot
 * refund. Every screen in the chain tells the truth and the reader still ends
 * up wrong. So removals are shown here, beside the additions, and a removal
 * reads differently from a plain absence: *"cannot refund"* and *"refund
 * taken away, by Maya, because…"* are different facts.
 *
 * ── WHAT IS NOT HERE ──
 * **No end date.** `UserFeatureGrant` is `feature · granted · reason ·
 * updatedBy`. An override lasts until someone removes it, and a date picker
 * that saved nothing would be the reassuring-direction failure.
 *
 * **No workload cap and no auto-assign.** Searched the whole schema and every
 * service: the only `maxConcurrent` is a voice-gateway socket limit read from
 * an env var. Neither is a field on a person.
 *
 * **No password reset and no session revoke.** Those are Authentik's, not
 * ours — GOTCHA stores no password and keeps no session store. The screen
 * says where they live rather than offering a button that hands off, because
 * **a button implies we did it, and when it fails the merchant blames us for
 * something we do not own.** Deactivating IS ours: `User.isActive`.
 */
export async function PersonPanel({ person }: { readonly person: Person }) {
  const t = await getTranslations('roles');

  const added = additions(person);
  const removed = removals(person);

  return (
    <div className={styles.person} data-testid="person-panel">
      <header className={styles.personHead}>
        <h2 className={styles.personName}>{person.name ?? person.email}</h2>
        <p className={styles.personMeta}>{person.email}</p>
      </header>

      {/*
        Scope comes from the role ASSIGNMENT, not from any permission — a
        permission only declares whether the dimension applies to it.
      */}
      <p className={styles.personScope} data-testid="person-scope">
        {person.scope ? t(`scope.${person.scope}` as 'scope.team') : t('scope.none')}
      </p>

      <section className={styles.overrides} data-testid="overrides">
        <h3 className={styles.overridesHeading}>{t('overrides.heading')}</h3>

        {person.grants.length === 0 ? (
          <p className={styles.overridesNone} data-testid="overrides-none">
            {t('overrides.none')}
          </p>
        ) : (
          <>
            {added.length > 0 ? (
              <ul className={styles.grantList} data-testid="grants-added">
                {added.map((grant) => (
                  <li key={grant.feature} className={styles.grant} data-kind="added">
                    <span className={styles.grantFeature}>{grant.feature}</span>
                    <span className={styles.grantWhat}>{t('overrides.added')}</span>
                    {grant.reason ? (
                      <span className={styles.grantWhy}>
                        {t('overrides.because', { reason: grant.reason })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {/*
              The half the design never describes, and the half that cannot be
              discovered any other way.
            */}
            {removed.length > 0 ? (
              <ul className={styles.grantList} data-testid="grants-removed">
                {removed.map((grant) => (
                  <li key={grant.feature} className={styles.grant} data-kind="removed">
                    <span className={styles.grantFeature}>{grant.feature}</span>
                    <span className={styles.grantWhat}>{t('overrides.removed')}</span>
                    {grant.reason ? (
                      <span className={styles.grantWhy}>
                        {t('overrides.because', { reason: grant.reason })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        {/* An override has no end date, so it does not pretend to. */}
        <p className={styles.overridesLast} data-testid="overrides-no-expiry">
          {t('overrides.noExpiry')}
        </p>
      </section>

      {/*
        Ours and not ours, told apart. Deactivating is `User.isActive`;
        password and sessions live in Authentik and we do not hold them.
      */}
      <p className={styles.elsewhere} data-testid="account-elsewhere">
        {t('elsewhere')}
      </p>
    </div>
  );
}
