import { getLocale, getTimeZone, getTranslations } from 'next-intl/server';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import type { Member } from '@/api/contracts/people';
import { additions, removals, type Person } from '@/api/contracts/roles';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';

import { RemovePermission } from './RemovePermission';
import styles from './Roles.module.css';

/**
 * 12d, measured: one person in a drawer over People - the head, Details,
 * Role, Teams, Extra permissions, how much they take on, the account's three
 * actions.
 *
 * What is live: taking an extra permission away (RemovePermission) and
 * adding one (12e, `&grant=1`). Everything else is drawn and not live, with
 * why on its title: names, role and teams change through other routes; job
 * title, mobile and a workload cap have no field at all; and password and
 * sessions are the identity provider's, not ours.
 */
export async function PersonPanel({
  person,
  permissions,
  member = null,
  roleDescription = null,
}: {
  readonly person: Person;
  readonly permissions: readonly PermissionDef[];
  /** The roster's row for this person - teams and open conversations. */
  readonly member?: Member | null;
  readonly roleDescription?: string | null;
}) {
  const t = await getTranslations('roles');
  const locale = await getLocale();
  const timeZone = await getTimeZone();
  /*
   * 02's "30 Sep": day first, in the workspace's zone - an end at 23:59 there
   * is 20:59 UTC, and read in UTC it would still be the right day only by luck.
   * Built from parts: `{ day, month }` in `en` is "Sep 30".
   */
  const parts = (unit: 'day' | 'month') =>
    new Intl.DateTimeFormat(locale, { timeZone, [unit]: unit === 'day' ? 'numeric' : 'short' });
  const day = { format: (at: Date) => `${parts('day').format(at)} ${parts('month').format(at)}` };

  const added = additions(person);
  const removed = removals(person);
  const who = person.name ?? person.email;

  const byKey = new Map(permissions.map((p) => [p.key, p]));
  const nameOf = (feature: string) => {
    const name = byKey.get(feature)?.displayName.trim();
    return name ? name : null;
  };
  const areaOf = (feature: string) => byKey.get(feature)?.domain || feature.split(':')[0] || '';

  const roleName = member?.roleName ?? person.role ?? null;
  const teams = member?.departments ?? [];
  const notLive = t('person.notLive');
  const noField = t('person.noField');

  return (
    <>
      <div className={drawer.drawerBody} data-testid="person-panel">
        <p className={styles.personChips}>
          {typeof member?.openConversations === 'number' ? (
            <span className={styles.personChip} data-testid="person-open">
              {t('person.open', { count: member.openConversations })}
            </span>
          ) : null}
          {teams.map((team) => (
            <span key={team.departmentId} className={styles.personChip}>
              {team.departmentName ?? '-'}
            </span>
          ))}
        </p>

        <h3 className={drawer.sectionTitle}>{t('person.details')}</h3>
        <div className={drawer.pair}>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('person.fullName')}</span>
            <span className={drawer.box} aria-disabled="true" title={notLive}>
              {person.name ?? '-'}
            </span>
          </div>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('person.jobTitle')}</span>
            <span className={drawer.box} aria-disabled="true" title={noField}>
              -
            </span>
          </div>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('person.mobile')}</span>
            <span className={drawer.box} aria-disabled="true" title={noField}>
              -
            </span>
          </div>
          <div className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('person.language')}</span>
            <span className={drawer.box} aria-disabled="true" title={noField}>
              -
            </span>
          </div>
        </div>

        <h3 className={drawer.sectionTitle}>{t('person.role')}</h3>
        <div className={styles.personRole} data-testid="person-role">
          <span className={styles.personRoleText}>
            <span className={styles.personRoleName}>{roleName || '-'}</span>
            {/*
            Scope comes from the role ASSIGNMENT, not from any permission - a
            permission only declares whether the dimension applies to it.
          */}
            <span className={styles.personRoleSub} data-testid="person-scope">
              {[
                roleDescription,
                person.scope ? t(`scope.${person.scope}` as 'scope.team') : t('scope.none'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <span className={styles.personQuiet} aria-disabled="true" title={notLive}>
            {t('person.change')}
          </span>
        </div>

        <div className={styles.personTeams}>
          <span className={drawer.fieldLabel}>{t('person.teams')}</span>
          {teams.length > 0 ? (
            teams.map((team) => (
              <span key={team.departmentId} className={styles.personChip}>
                {team.departmentName ?? '-'}
              </span>
            ))
          ) : (
            <span className={styles.personNone}>-</span>
          )}
          <span className={styles.personQuiet} aria-disabled="true" title={notLive}>
            {t('person.addTeam')}
          </span>
        </div>

        {/* 02: a section, not a boxed card - title, who it is for, + Add. */}
        <section className={styles.extraSection} data-testid="overrides">
          <header className={styles.personSectionHead}>
            <h3 className={drawer.sectionTitle}>{t('person.extra')}</h3>
            <span className={styles.personQuiet}>
              {t('person.onTop', { name: who, role: roleName || '-' })}
            </span>
            <Link
              href={{ pathname: '/settings/people', query: { person: person.id, grant: '1' } }}
              className={styles.personAdd}
              data-testid="person-add-permission"
              scroll={false}
            >
              {t('person.addPermission')}
            </Link>
          </header>

          {person.grants.length === 0 ? (
            <p className={styles.overridesNone} data-testid="overrides-none">
              {t('overrides.none')}
            </p>
          ) : (
            <>
              {added.length > 0 ? (
                <ul className={styles.grantList} data-testid="grants-added">
                  {added.map((grant) => (
                    <li
                      key={grant.feature}
                      className={styles.grant}
                      data-kind="added"
                      data-ended={grant.active ? undefined : ''}
                      data-testid={`grant-${grant.feature}`}
                    >
                      <span className={styles.grantText}>
                        <span className={styles.grantFeature}>
                          {nameOf(grant.feature) ?? grant.feature}
                        </span>
                        <span className={styles.grantWhy}>
                          {[
                            areaOf(grant.feature),
                            grant.updatedAt
                              ? t('person.addedOn', { date: day.format(new Date(grant.updatedAt)) })
                              : null,
                            grant.reason ? t('overrides.because', { reason: grant.reason }) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {nameOf(grant.feature) === null ? (
                          <span
                            className={styles.grantWhy}
                            data-testid={`uncatalogued-${grant.feature}`}
                          >
                            {t('overrides.notInCatalogue')}
                          </span>
                        ) : null}
                      </span>
                      {/* 02: "Ends 30 Sep" - or, once past, "Ended 3 Oct" (the row stays). */}
                      <span
                        className={styles.personQuiet}
                        data-testid={`grant-ends-${grant.feature}`}
                      >
                        {grant.expiresAt === null
                          ? t('person.noEnd')
                          : t(grant.active ? 'person.ends' : 'person.ended', {
                              date: day.format(new Date(grant.expiresAt)),
                            })}
                      </span>
                      {/*
                      ⚠ A WRITE against a real person. No test and no capture
                      presses it. Only on an ADDED grant.
                    */}
                      <RemovePermission
                        userId={person.id}
                        personName={who}
                        feature={grant.feature}
                        featureName={nameOf(grant.feature) ?? grant.feature}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The half the design never describes, and that nothing else shows. */}
              {removed.length > 0 ? (
                <ul className={styles.grantList} data-testid="grants-removed">
                  {removed.map((grant) => (
                    <li key={grant.feature} className={styles.grant} data-kind="removed">
                      <span className={styles.grantText}>
                        <span className={styles.grantFeature}>
                          {nameOf(grant.feature) ?? grant.feature}
                        </span>
                        <span className={styles.grantWhy}>
                          {[
                            t('overrides.removed'),
                            grant.reason ? t('overrides.because', { reason: grant.reason }) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </section>

        {/* 02's workload line. Nothing stores a cap or auto-assignment. */}
        <p className={styles.personWorkload} title={noField} data-testid="person-workload">
          <span>{t('person.atOnce')}</span>
          <span className={styles.personNone}>-</span>
          <span>{t('person.autoAssign')}</span>
          <span className={styles.personNone}>-</span>
        </p>

        {/*
        Drawn, not live. Password and sessions are the identity provider's;
        deactivating is ours (`User.isActive`) and not wired from here.
      */}
        <p className={styles.personAccount} data-testid="account-elsewhere">
          <span className={styles.personQuiet} aria-disabled="true" title={t('elsewhere')}>
            {t('person.resetPassword')}
          </span>
          <span className={styles.personQuiet} aria-disabled="true" title={t('elsewhere')}>
            {t('person.signOutAll')}
          </span>
          <span className={styles.personDanger} aria-disabled="true" title={notLive}>
            {t('person.deactivate')}
          </span>
          <span className="srOnly">{t('elsewhere')}</span>
        </p>
      </div>
      {/*
      02's footer. Nothing in this drawer is a field you save - the two
      writes (add, remove) save themselves - so Save is drawn and not live.
    */}
      <footer className={drawer.drawerFoot}>
        <span
          className={styles.personSave}
          aria-disabled="true"
          title={t('person.nothingToSave')}
          data-testid="person-save"
        >
          {t('person.save')}
        </span>
        <Link href="/settings/people" className={drawer.drawerCancel}>
          {t('person.cancel')}
        </Link>
      </footer>
    </>
  );
}
