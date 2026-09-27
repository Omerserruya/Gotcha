import { getTranslations } from 'next-intl/server';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import { additions, removals, type Person } from '@/api/contracts/roles';

import { RemovePermission } from './RemovePermission';

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
export async function PersonPanel({
  person,
  permissions,
}: {
  readonly person: Person;
  /**
   * The catalogue, for `displayName`. Empty when the catalogue read failed —
   * and then every row shows its key with the caption that says why, rather
   * than a blank where a name should be.
   */
  readonly permissions: readonly PermissionDef[];
}) {
  const t = await getTranslations('roles');

  const added = additions(person);
  const removed = removals(person);

  /*
   * ★★ THE CATALOGUE'S OWN NAME FOR A PERMISSION, NOT ITS KEY.
   *
   * `grant.feature` was rendered raw — `ai:knowledge:write` on the screen a
   * manager uses to decide what somebody may do. `PermissionDef.displayName`
   * has existed for as long as the catalogue has.
   *
   * ── AND A KEY THE CATALOGUE DOES NOT DESCRIBE IS ITSELF WORTH SEEING ──
   * Unlike a channel enum, an override on a permission the catalogue has never
   * heard of is not noise — it is somebody granting something the product
   * cannot explain. So the key IS shown in that case, with a sentence saying
   * it is not in the catalogue. Hiding it would hide the more interesting of
   * the two states.
   */
  const named = new Map(
    permissions.filter((p) => p.displayName.trim() !== '').map((p) => [p.key, p.displayName]),
  );
  const nameOf = (feature: string) => named.get(feature) ?? null;

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
                    <span className={styles.grantFeature}>
                      {nameOf(grant.feature) ?? grant.feature}
                    </span>
                    <span className={styles.grantWhat}>{t('overrides.added')}</span>
                    {nameOf(grant.feature) === null ? (
                      <span
                        className={styles.grantWhy}
                        data-testid={`uncatalogued-${grant.feature}`}
                      >
                        {t('overrides.notInCatalogue')}
                      </span>
                    ) : null}
                    {grant.reason ? (
                      <span className={styles.grantWhy}>
                        {t('overrides.because', { reason: grant.reason })}
                      </span>
                    ) : null}
                    {/*
                      ★★ 12e's SECOND PATH, WHICH THE DESIGN DESCRIBES AND
                      NOTHING MOUNTED. Taking a permission away from one
                      person, beside the grant it takes away — the only place
                      the reader can see what they are removing.

                      ⚠ IT IS A WRITE against a real person on a tenant that
                      sends live traffic. No test and no capture presses it.
                      Only on an ADDED grant: removing an already-removed one
                      is a control for a state the reader is looking at.
                    */}
                    <RemovePermission
                      /* `person.id` is `User.id` — `personDetailSchema` maps it from the
                         route's `user.id`. Verified, because it is the target of a write. */
                      userId={person.id}
                      personName={person.name ?? person.email}
                      feature={grant.feature}
                      featureName={nameOf(grant.feature) ?? grant.feature}
                    />
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
                    <span className={styles.grantFeature}>
                      {nameOf(grant.feature) ?? grant.feature}
                    </span>
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
