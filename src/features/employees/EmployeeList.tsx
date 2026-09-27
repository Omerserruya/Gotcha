import { getFormatter, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { aloneRate, inactiveSources, roleKeyOf, type Employee } from '@/api/contracts/employees';
import { channelNameList } from '@/api/contracts/inbox';

import styles from './Employees.module.css';
import { DeleteEmployee } from './DeleteEmployee';
import { PauseEmployee } from './PauseEmployee';

/**
 * Screen 07 — the AI employees.
 *
 * ── THE COUNTS, CAPTIONED AS WHAT THEY ARE ──
 * `openConversations` is OPEN **plus WAITING**, and the route's own note says
 * WAITING is usually waiting on the *customer*. So it is never captioned as
 * live activity — *"open right now"*, not *"being handled"*.
 *
 * `resolvedAlone / handledConversations` is the only rate the data supports,
 * and it is `null` rather than `0%` for an employee nothing has been routed
 * to — "never handled one" and "needed help every time" are opposite facts.
 *
 * ── AND THE COLUMN THAT IS NOT HERE ──
 * **No escalations.** `isHandedOver` has six-plus writers sharing only "a
 * person ended up driving", and the cause would need
 * `ConversationHandover.reason`, which **holds zero rows while five
 * conversations carry the flag**. A cause column would be a confident zero for
 * every employee, which is worse than no column.
 */
export async function EmployeeList({ employees }: { readonly employees: readonly Employee[] }) {
  const t = await getTranslations('employees');
  const channelNames = await getTranslations('channels');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <ul className={styles.list} data-testid="employee-list">
      {employees.map((employee) => {
        const rate = aloneRate(employee);
        return (
          <li
            key={employee.id}
            className={styles.employee}
            data-testid={`employee-${employee.id}`}
            data-status={employee.status}
          >
            <div className={styles.head}>
              <h3 className={styles.name}>{employee.name}</h3>
              <span className={styles.status} data-testid={`status-${employee.id}`}>
                {t(`status.${employee.status}` as 'status.ACTIVE')}
              </span>
              {employee.departmentName ? (
                <span className={styles.dept}>{employee.departmentName}</span>
              ) : null}
            </div>

            {/*
              Where it answers. Channels are the employee's reach, and an
              employee with none answers nowhere — which is worth seeing.
            */}
            {/*
              ★★ THE FIFTH RENDERER OF A CHANNEL ENUM. This read
              `employee.channels.join(' · ')`, so an employee on two channels
              said "WHATSAPP · INSTAGRAM". Found by grepping `.channels`, not by
              looking at a screen — the same sweep found three more in one pass.
            */}
            <p className={styles.channels} data-testid={`channels-${employee.id}`}>
              {employee.channels.length > 0
                ? t('onChannels', {
                    channels: channelNameList(employee.channels, channelNames).join(' · '),
                  })
                : t('noChannels')}
            </p>

            {/*
              ════════════════════════════════════════════════════════════════
              ★★ THREE FIELDS WE PARSED AND DROPPED ON THE FLOOR
              ════════════════════════════════════════════════════════════════
              A browser walk read this screen as "a name and three numbers".
              `role`, `knowledgeSources` and `lastTestedAt` were all in the
              contract, all on the wire, and rendered nowhere — so the screen
              described an AI colleague by its throughput and nothing else.

              ★ EVERY ROW IS RENDERED EVEN WHEN ITS VALUE IS EMPTY, and that is
                the decision worth reading twice. An omitted row says "this
                product has no such concept"; a row that says nobody filled it
                in says "this one is unfinished". Only the second is true, and
                the second is the useful one — an employee nobody has described,
                with nothing attached, that nobody has ever opened in the test
                chat, is a draft somebody walked away from. That is the row a
                reader most needs to see, and it was the row rendering nothing.
            */}
            <dl className={styles.profile} data-testid={`profile-${employee.id}`}>
              <div className={styles.profileRow}>
                <dt>{t('role.label')}</dt>
                <dd data-testid={`role-${employee.id}`}>
                  {roleKeyOf(employee) ? (
                    t(`role.${roleKeyOf(employee)}` as 'role.sales')
                  ) : employee.role.trim() !== '' ? (
                    /*
                     * A role the platform has added since this catalogue was
                     * written. Humanised rather than dropped: the value is true
                     * and the only thing missing is our word for it.
                     */
                    humaniseCode(employee.role)
                  ) : (
                    <span className={styles.unset}>{t('role.unset')}</span>
                  )}
                </dd>
              </div>

              <div className={styles.profileRow}>
                <dt>{t('knowledge.label')}</dt>
                <dd data-testid={`knowledge-${employee.id}`}>
                  {employee.knowledgeSources.length === 0 ? (
                    <span className={styles.unset}>{t('knowledge.none')}</span>
                  ) : (
                    <>
                      <span>
                        {employee.knowledgeSources
                          .map((source) => source.name || humaniseCode(source.id))
                          .join(' · ')}
                      </span>
                      {/*
                        ★ A SOURCE ATTACHED AND TURNED OFF IS THE STATE THAT
                          MISLEADS. The list reads as "it knows these things"
                          while one of them is unreadable, so the count of
                          unreadable ones is said out loud rather than shown as
                          a subtle style on one name.
                      */}
                      {inactiveSources(employee) > 0 ? (
                        <span className={styles.warn} data-testid={`knowledge-off-${employee.id}`}>
                          {t('knowledge.someInactive', { count: inactiveSources(employee) })}
                        </span>
                      ) : null}
                    </>
                  )}
                </dd>
              </div>

              <div className={styles.profileRow}>
                <dt>{t('tested.label')}</dt>
                <dd data-testid={`tested-${employee.id}`}>
                  {employee.lastTestedAt ? (
                    t('tested.at', { when: when(employee.lastTestedAt) })
                  ) : (
                    /*
                     * The contract's own words: "last time someone opened the
                     * test chat". Not "never tested" — that would be a claim
                     * about whether anybody checked this employee at all, and
                     * opening a chat window is not the same as testing.
                     */
                    <span className={styles.unset}>{t('tested.never')}</span>
                  )}
                </dd>
              </div>
            </dl>

            <dl className={styles.counts}>
              <div className={styles.count}>
                {/* OPEN + WAITING — never captioned as live activity. */}
                <dt>{t('count.open')}</dt>
                <dd data-testid={`open-${employee.id}`}>
                  {format.number(employee.openConversations)}
                </dd>
              </div>

              <div className={styles.count}>
                <dt>{t('count.handled')}</dt>
                <dd>{format.number(employee.handledConversations)}</dd>
              </div>

              <div className={styles.count} data-testid={`alone-${employee.id}`}>
                <dt>{t('count.alone')}</dt>
                <dd>
                  {rate === null ? (
                    // Nothing routed here yet. Not 0%, which would say it
                    // needed help every time.
                    <span className={styles.notYet}>{t('count.nothingYet')}</span>
                  ) : (
                    <>
                      {format.number(rate, { style: 'percent' })}
                      <span className={styles.of}>
                        {t('count.ofHandled', { count: employee.handledConversations })}
                      </span>
                    </>
                  )}
                </dd>
              </div>
            </dl>

            <div className={styles.rowActions}>
              <PauseEmployee
                id={employee.id}
                name={employee.name}
                openConversations={employee.openConversations}
                paused={employee.status === 'PAUSED'}
              />
              {/*
                Delete sits beside pause because they are the two things you
                can do to an employee — and `RETIRED` is not one of them, which
                the note above the list says outright.
              */}
              <DeleteEmployee employee={employee} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
