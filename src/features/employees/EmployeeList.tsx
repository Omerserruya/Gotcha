import { getFormatter, getTranslations } from 'next-intl/server';

import { aloneRate, type Employee } from '@/api/contracts/employees';

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
  const format = await getFormatter();

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
            <p className={styles.channels} data-testid={`channels-${employee.id}`}>
              {employee.channels.length > 0
                ? t('onChannels', { channels: employee.channels.join(' · ') })
                : t('noChannels')}
            </p>

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
