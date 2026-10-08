'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { channelName, channelNameList } from '@/api/contracts/inbox';
import type {
  AssignmentChannel,
  WebsiteWidget,
  WidgetAssignment,
} from '@/api/contracts/website-widget';
import { UnavailableItem } from '@/design-system/primitives/unavailable/Unavailable';
import { automationsLink } from '@/features/employees/WhoAnswers';
import { useRouter } from '@/i18n/navigation';
import { initials } from '@/lib/brand-mark';

import { saveWidgetAssignment, type AssignmentSave } from './website-widget-actions';
import styles from './Webchat.module.css';

/**
 * ★★ "Assigned AI employee" - chosen here, written to THE PLAYBOOK (Omer,
 * 2026-10-08; website-widget-v1 §4). One source: the playbook still decides
 * who answers, and this card is a second door into it, not a second rule.
 *
 * - A channel whose route conditions decide (`editable: false`) is read,
 *   with the way to the playbook - never overwritten from here.
 * - A route shared with other channels (dev: one start → Maya for every
 *   channel) is never changed silently. `movesWith` names what a change
 *   would also move, and the card asks before writing anything ("This also
 *   moves WhatsApp to Dan"); a service without it answers 409
 *   PLAYBOOK_SHARED, which writes nothing, and the card asks then.
 * - It reaches live conversations at once, and says so beside the choice.
 *
 * Admins only, like the playbook editor. For anyone else, or when the
 * assignment could not be read, the card is what it was: the widget's own
 * read-only `assignedEmployee` and where it is set.
 */
export function WidgetAssignmentCard({
  read,
  assigned,
}: {
  /** `null`: could not be read; `'forbidden'`: not an admin. */
  readonly read: WidgetAssignment | 'forbidden' | null;
  readonly assigned: WebsiteWidget['assignedEmployee'];
}) {
  const t = useTranslations('channels.webchat.conversation');
  if (read === null || read === 'forbidden' || read.channels.length === 0) {
    return (
      <>
        <p className={styles.assigned} data-testid="webchat-employee-who">
          {assigned ? (
            <>
              <span className={styles.assignedMark} aria-hidden="true">
                {initials(assigned.name)}
              </span>
              <bdi dir="auto">{assigned.name}</bdi>
            </>
          ) : (
            t('employeeNone')
          )}
        </p>
        {read === 'forbidden' ? (
          <p className={styles.rowHint} data-testid="webchat-employee-admins">
            {t('assign.adminsOnly')}
          </p>
        ) : read !== null ? (
          <p className={styles.rowHint} data-testid="webchat-employee-noplace">
            {t('assign.noPlace')}
          </p>
        ) : null}
        <p className={styles.rowHint} data-testid="webchat-employee-where">
          {t.rich('employeeWhere', { automations: automationsLink })}
        </p>
      </>
    );
  }
  return <Chooser initial={read} />;
}

/** The employee every editable channel goes to today, or `null` when they differ or none does. */
function currentEmployee(channels: readonly AssignmentChannel[]): string | null {
  const ids = channels.map((c) => (c.how === 'always' ? (c.employee?.id ?? null) : null));
  const first = ids[0] ?? null;
  return first !== null && ids.every((id) => id === first) ? first : null;
}

function Chooser({ initial }: { readonly initial: WidgetAssignment }) {
  const t = useTranslations('channels.webchat.conversation.assign');
  const names = useTranslations('channels');
  const router = useRouter();
  const [assignment, setAssignment] = useState(initial);
  const editable = assignment.channels.filter((c) => c.editable);
  const fixed = assignment.channels.filter((c) => !c.editable);
  const now = currentEmployee(editable);
  const [choice, setChoice] = useState<string | null>(now);
  const [result, setResult] = useState<AssignmentSave | null>(null);
  // Asked before any write: the change also moves other channels.
  const [asking, setAsking] = useState(false);
  const [isPending, startTransition] = useTransition();

  const several = assignment.channels.length > 1;
  const chosen = assignment.employees.find((e) => e.id === choice) ?? null;
  /*
   * What else a change moves. `movesWith` says it before any write (Backend
   * a9c26456); a service without it answers 409 PLAYBOOK_SHARED, writing
   * nothing, and the read's `sharedWith` names them instead.
   */
  const known = editable.every((c) => c.movesWith !== undefined);
  const widgetChannels = new Set(assignment.channels.map((c) => c.channel));
  const moves = channelNameList(
    known
      ? [...new Set(editable.flatMap((c) => c.movesWith ?? []))]
      : [...new Set(editable.flatMap((c) => c.sharedWith))].filter((c) => !widgetChannels.has(c)),
    names,
  );

  const save = (includeShared: boolean) =>
    startTransition(async () => {
      setAsking(false);
      if (!choice) return;
      const done = await saveWidgetAssignment(
        choice,
        editable.map((c) => c.channel),
        includeShared,
      );
      setResult(done);
      if (done.ok) {
        setAssignment(done.assignment);
        router.refresh();
      }
    });

  const who = (c: AssignmentChannel) =>
    c.how === 'always' && c.employee ? c.employee.name : t(`how.${c.how}`);

  return (
    <>
      {/* Today, per the playbook: one line per place when there are two. */}
      <ul className={styles.assignNow} data-testid="webchat-employee-now">
        {assignment.channels.map((c) => (
          <li key={c.channel} data-testid={`webchat-employee-now-${c.channel}`}>
            {several ? <span>{channelName(c.channel, names)}: </span> : null}
            <bdi dir="auto">{who(c)}</bdi>
          </li>
        ))}
      </ul>

      {fixed.length > 0 ? (
        <p className={styles.rowHint} data-testid="webchat-employee-conditional">
          {t.rich('conditional', {
            channels: channelNameList(
              fixed.map((c) => c.channel),
              names,
            ).join(', '),
            automations: automationsLink,
          })}
        </p>
      ) : null}

      {editable.length > 0 ? (
        <>
          <div role="radiogroup" aria-label={t('choose')} className={styles.assignChoices}>
            {assignment.employees.map((employee) =>
              employee.active ? (
                <label key={employee.id} className={styles.radio}>
                  <input
                    type="radio"
                    name="webchat-employee"
                    checked={choice === employee.id}
                    onChange={() => {
                      setResult(null);
                      setChoice(employee.id);
                    }}
                    data-testid={`webchat-employee-${employee.id}`}
                  />
                  <bdi dir="auto">{employee.name}</bdi>
                </label>
              ) : (
                <UnavailableItem
                  key={employee.id}
                  title={<bdi dir="auto">{employee.name}</bdi>}
                  tag={t('inactive')}
                  why={t('inactiveWhy')}
                  testid={`webchat-employee-${employee.id}`}
                />
              ),
            )}
          </div>
          <p className={styles.rowHint} data-testid="webchat-employee-playbook">
            {t('playbook')}
          </p>

          {asking || (result && !result.ok && result.reason === 'shared') ? (
            <div className={styles.assignAsk} role="alert" data-testid="webchat-employee-shared">
              <p>
                {moves.length > 0
                  ? t('shared.ask', { channels: moves.join(', '), name: chosen?.name ?? '' })
                  : t('shared.askUnnamed', { name: chosen?.name ?? '' })}
              </p>
              <span className={styles.assignActions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={isPending}
                  onClick={() => save(true)}
                  data-testid="webchat-employee-shared-yes"
                >
                  {t('shared.yes')}
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={isPending}
                  onClick={() => {
                    setAsking(false);
                    setResult(null);
                  }}
                  data-testid="webchat-employee-shared-no"
                >
                  {t('shared.no')}
                </button>
              </span>
            </div>
          ) : (
            <span className={styles.assignActions}>
              <button
                type="button"
                className={styles.primary}
                disabled={!chosen || choice === now || isPending}
                onClick={() => {
                  setResult(null);
                  // Known to move others: asked first, and nothing is written until yes.
                  if (known && moves.length > 0) setAsking(true);
                  else save(false);
                }}
                data-testid="webchat-employee-save"
              >
                {isPending
                  ? t('saving')
                  : chosen && choice !== now
                    ? t('save', { name: chosen.name })
                    : t('saveNothing')}
              </button>
            </span>
          )}

          {result?.ok ? (
            <p className={styles.rowHint} role="status" data-testid="webchat-employee-saved">
              {t('saved', { name: chosen?.name ?? '' })}
            </p>
          ) : result && result.reason !== 'shared' ? (
            <p className={styles.assignProblem} role="alert" data-testid="webchat-employee-problem">
              {t(`problem.${result.reason}`)}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
