'use client';

import {
  CalendarDays,
  ChevronDown,
  CreditCard,
  Database,
  Handshake,
  Headset,
  MessageSquare,
  Package,
  RotateCcw,
  Shapes,
  ShoppingBag,
  StickyNote,
  TicketPercent,
  Truck,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { TOOL_LEVELS, type EmployeeTool, type ToolLevel } from '@/api/contracts/employees';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import { useRouter } from '@/i18n/navigation';

import hire from '../hire/Hire.module.css';
import styles from './EmployeePage.module.css';
import { setEmployeeToolGrant, type ToolGrantResult } from './tool-grant-actions';
import { setEmployeeToolLevel, type ToolLevelResult } from './tool-level-actions';
import { toolSections, type ToolDomainGroup } from './tool-sections';

/** E3: a business section's icon, by the server's `domainIcon`; any other is the shapes. */
export const DOMAIN_ICONS: Readonly<Record<string, LucideIcon>> = {
  orders: ShoppingBag,
  products: Package,
  customers: Users,
  coupons: TicketPercent,
  payments: CreditCard,
  shipping: Truck,
  returns: RotateCcw,
  leads: Handshake,
  notes: StickyNote,
  records: Database,
  calendar: CalendarDays,
  messaging: MessageSquare,
  handover: Headset,
  automation: Workflow,
};

/** The page's stance colours, by level. */
const STANCE_OF: Readonly<Record<ToolLevel, string>> = {
  execute: 'on_its_own',
  ask: 'ask_first',
  never: 'never',
};

/** One action as the list draws it: the server's levels, and its name in words. */
export type ToolLevelRow = Pick<
  EmployeeTool,
  | 'toolName'
  | 'workspaceLevel'
  | 'ownLevel'
  | 'employeeLevel'
  | 'allowedLevels'
  | 'granted'
  | 'grantable'
> & {
  /** "{integration} · {action}", for a line that names it alone (the 07 card). */
  readonly label: string;
  /** E3: the action's own name, under its integration's heading. */
  readonly action?: string;
  /** E3: where it is drawn - see `tool-sections.ts`. */
  readonly integration?: string | null;
  readonly integrationName?: string | null;
  readonly domain?: string | null;
  readonly domainIcon?: string | null;
  readonly domainLabel?: string | null;
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT THIS EMPLOYEE MAY DO, PER ACTION (Omer, 2026-10-13, E5)
 * ════════════════════════════════════════════════════════════════════════════
 * "What it may do on its own" and "when it hands over" were read-only. They
 * are one editable list now, as Integrations draws it: every action, and
 * לבצע / לשאול אותי / אף פעם for THIS employee.
 *
 * ★ NEVER LOOSER THAN THE WORKSPACE. The server sends the levels this
 *   employee may be set to (`allowedLevels`); the rest are drawn and
 *   greyed, with the workspace's own level as the reason, and the server
 *   refuses them anyway (422). A level saves as it is pressed; one equal to
 *   the workspace's is stored as "like the workspace".
 *
 * ★ GIVEN TO IT (Backend 9339ca26). An integration's action reaches an
 *   employee only when given to it: "לתת לו" switches that, and saves as it
 *   is pressed. One the workspace has not set up cannot be given - greyed,
 *   with why. A built-in needs no grant and has no switch.
 */
export function EmployeeToolLevels({
  employeeId,
  rows,
}: {
  readonly employeeId: string;
  /** `null` when the read failed. */
  readonly rows: readonly ToolLevelRow[] | null;
}) {
  const t = useTranslations('employees.page.levels');
  if (rows === null) {
    return (
      <p className={styles.quiet} data-testid="levels-unavailable">
        {t('unavailable')}
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className={styles.quiet}>{t('none')}</p>;
  }
  return (
    <>
      <p className={styles.note} data-testid="levels-rule">
        {t('rule')}
      </p>
      {/*
        ★★ E3 (Omer, 2026-10-14): by integration, then by business section,
        each section opened and closed on its own - see tool-sections.ts.
      */}
      <div className={styles.toolGroups} data-testid="levels-rows">
        {toolSections(rows).map((group) => {
          const key = group.integration ?? 'gotcha';
          return (
            <section
              key={key}
              className={styles.toolIntegration}
              data-testid={`levels-integration-${key}`}
            >
              <h4 className={styles.toolIntegrationName}>
                {group.integration ? (
                  <IntegrationLogo slug={group.integration} size="pill" />
                ) : null}
                <bdi dir="auto">{group.name ?? t('builtIn')}</bdi>
              </h4>
              {group.domains.map((domain) => (
                <DomainGroup key={domain.domain} employeeId={employeeId} at={key} group={domain} />
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

/** One business section: its icon, name and count; its actions shown when opened. */
function DomainGroup({
  employeeId,
  at,
  group,
}: {
  readonly employeeId: string;
  /** The integration it is under, for its ids. */
  readonly at: string;
  readonly group: ToolDomainGroup;
}) {
  const t = useTranslations('employees.page.levels');
  const [open, setOpen] = useState(false);
  const Icon = (group.icon ? DOMAIN_ICONS[group.icon] : undefined) ?? Shapes;
  const id = `levels-${at}-${group.domain}`;
  return (
    <div className={styles.toolDomain} data-testid={`levels-domain-${at}-${group.domain}`}>
      <button
        type="button"
        className={styles.toolDomainHead}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={`levels-domain-toggle-${at}-${group.domain}`}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon className={styles.toolDomainIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className={styles.toolDomainName}>{group.label ?? t('otherSection')}</span>
        <span className={styles.toolDomainCount}>{group.rows.length}</span>
        <ChevronDown className={styles.toolDomainChevron} size={14} aria-hidden="true" />
      </button>
      {/*
        Not drawn while closed - never `hidden`: `.rows` sets `display: flex`,
        which beats the browser's own `[hidden]` rule, so on dev every closed
        section still showed its rows while jsdom, which applies no CSS
        module, called them hidden.
      */}
      {open ? (
        <ul id={id} className={styles.rows}>
          {group.rows.map((row) => (
            <LevelRow key={row.toolName} employeeId={employeeId} row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LevelRow({
  employeeId,
  row,
}: {
  readonly employeeId: string;
  readonly row: ToolLevelRow;
}) {
  const t = useTranslations('employees.page.levels');
  const router = useRouter();
  const [level, setLevel] = useState<ToolLevel>(row.employeeLevel);
  const [own, setOwn] = useState(row.ownLevel !== null && row.ownLevel !== undefined);
  const [result, setResult] = useState<ToolLevelResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [given, setGiven] = useState(row.granted === true);
  const [granting, setGranting] = useState<ToolGrantResult | null>(null);
  const [isGranting, startGrant] = useTransition();

  const give = (next: boolean) => {
    setGranting(null);
    setGiven(next);
    startGrant(async () => {
      const done = await setEmployeeToolGrant(employeeId, row.toolName, next);
      setGranting(done);
      if (done.ok) router.refresh();
      else setGiven(!next);
    });
  };

  const write = (next: ToolLevel | null) => {
    const was = { level, own };
    const target = next ?? row.workspaceLevel;
    setResult(null);
    setLevel(target);
    setOwn(next !== null && next !== row.workspaceLevel);
    startTransition(async () => {
      const done = await setEmployeeToolLevel(
        employeeId,
        row.toolName,
        next === row.workspaceLevel ? null : next,
      );
      setResult(done);
      if (done.ok) router.refresh();
      else {
        setLevel(was.level);
        setOwn(was.own);
      }
    });
  };

  return (
    <li
      className={`${styles.row} ${styles.levelRow}`}
      data-testid={`level-${row.toolName}`}
      // Not given: it cannot use it, so its level is drawn dimmed, never as active.
      data-given={row.granted !== null && !given ? 'no' : undefined}
    >
      <span className={styles.rowName}>
        {/* Under its integration's heading, the action's own name; aria keeps the full one. */}
        <bdi dir="auto">{row.action ?? row.label}</bdi>
        <span className={styles.state} data-testid={`level-source-${row.toolName}`}>
          {own ? t('own') : t('likeWorkspace')}
        </span>
        {row.granted !== null && !given ? (
          <span className={styles.state} data-testid={`level-not-given-${row.toolName}`}>
            {row.grantable ? t('notGiven') : t('notGrantable')}
          </span>
        ) : null}
      </span>
      {row.granted !== null ? (
        <label
          className={styles.giveRow}
          title={row.grantable ? undefined : t('notGrantable')}
          data-testid={`level-give-row-${row.toolName}`}
        >
          <span>{t('give')}</span>
          <input
            type="checkbox"
            role="switch"
            className={hire.switch}
            checked={given}
            aria-label={t('giveFor', { name: row.label })}
            aria-disabled={row.grantable ? undefined : 'true'}
            disabled={isGranting}
            data-testid={`level-give-${row.toolName}`}
            onChange={(e) => {
              if (!row.grantable) return;
              give(e.target.checked);
            }}
          />
        </label>
      ) : null}
      <span className={styles.stances} role="group" aria-label={row.label}>
        {TOOL_LEVELS.map((option) => {
          const allowed = row.allowedLevels.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`${styles.stance} ${styles.stanceButton}`}
              data-stance={STANCE_OF[option]}
              data-current={level === option ? 'yes' : 'no'}
              aria-pressed={level === option}
              aria-disabled={allowed ? undefined : 'true'}
              title={
                allowed
                  ? undefined
                  : t('looserThanWorkspace', { level: t(`level.${row.workspaceLevel}`) })
              }
              disabled={isPending}
              data-testid={`level-${row.toolName}-${option}`}
              onClick={() => {
                if (!allowed || option === level) return;
                write(option);
              }}
            >
              {t(`level.${option}`)}
            </button>
          );
        })}
      </span>
      {own ? (
        <button
          type="button"
          className={styles.linkButton}
          disabled={isPending}
          data-testid={`level-reset-${row.toolName}`}
          onClick={() => write(null)}
        >
          {t('reset')}
        </button>
      ) : null}
      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid={`level-problem-${row.toolName}`}>
          {t(`problem.${result.reason}`)}
        </p>
      ) : null}
      {granting && !granting.ok ? (
        <p
          className={styles.problem}
          role="alert"
          data-testid={`level-give-problem-${row.toolName}`}
        >
          {granting.reason === 'not_provisioned'
            ? t('notGrantable')
            : t(`problem.${granting.reason}`)}
        </p>
      ) : null}
    </li>
  );
}
