import { getFormatter, getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { roleKeyOf, type Employee } from '@/api/contracts/employees';
import { Link } from '@/i18n/navigation';
import styles from '@/features/studio/StudioSplit.module.css';

/**
 * 07's list column: one row per employee - a dot, the name, and how many
 * conversations it holds, or that it is paused - with what it does under it.
 *
 * ⚠ 02's row says "88 live". `openConversations` is OPEN + WAITING, and the
 * route's own note says WAITING is mostly waiting on the CUSTOMER, so the
 * figure is captioned "open", never "live". The line under the name is the
 * role: an employee has no description field.
 */
export async function EmployeeRail({
  employees,
  selectedId,
}: {
  readonly employees: readonly Employee[];
  readonly selectedId: string;
}) {
  const t = await getTranslations('employees');
  const format = await getFormatter();
  return (
    <>
      {employees.map((employee) => {
        const roleKey = roleKeyOf(employee);
        return (
          <Link
            key={employee.id}
            href={{ pathname: '/studio/employees', query: { employee: employee.id } }}
            className={styles.row}
            aria-current={employee.id === selectedId ? 'page' : undefined}
            data-testid={`rail-${employee.id}`}
          >
            <span className={styles.rowTop}>
              <span
                className={styles.dot}
                data-tone={employee.status === 'ACTIVE' ? 'live' : undefined}
                aria-hidden="true"
              />
              <span className={styles.rowName}>{employee.name}</span>
              {employee.status === 'ACTIVE' ? (
                <span className={styles.rowCount}>
                  {t('rail.open', { n: format.number(employee.openConversations) })}
                </span>
              ) : (
                <span className={styles.rowState}>
                  {t(`status.${employee.status}` as 'status.ACTIVE')}
                </span>
              )}
            </span>
            <span className={styles.rowLine}>
              {roleKey
                ? t(`role.${roleKey}` as 'role.sales')
                : employee.role.trim() !== ''
                  ? humaniseCode(employee.role)
                  : t('role.unset')}
            </span>
          </Link>
        );
      })}
      {/*
        02's foot, as far as it is true: knowledge is attached PER EMPLOYEE
        (each has its own sources), so a change reaches every employee that
        reads that source - not "everyone".
      */}
      <p className={styles.listFoot} data-testid="list-foot">
        {t('rail.foot')}
      </p>
    </>
  );
}
