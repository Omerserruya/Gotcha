'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { finishedConversations, type Employee } from '@/api/contracts/employees';

import { deleteEmployee } from './actions';
import styles from './Employees.module.css';

/**
 * Deleting an AI employee, with the three things it actually does.
 *
 * ── THE CONSEQUENCE IS STATED, WITH THE NUMBER ──
 * Omer's wording, and it is the acceptance criterion rather than a draft:
 * *"14 people are mid-conversation with it. They will stop getting replies
 * and will wait unassigned until someone claims them."*
 *
 * That sentence is true because of a deliberate implementation choice, not by
 * luck: the route clears `handledBy` as well as the employee id. Clearing the
 * id alone would leave the conversation reading as *"the AI is handling
 * this"* - so it would sit unanswered **while the inbox told a human it was
 * covered.**
 *
 * ── AND THE HISTORY SURVIVES, WHICH IT MUST SAY ──
 * Only **live** conversations are released. Finished ones keep the employee's
 * id, because on a closed thread that id is the record of **who handled it**
 * - and it is what this screen's own "handled in total" figure reads.
 *
 * **A merchant who believes deleting an employee erases its record will make
 * a different decision than one who knows it does not.** So the dialog says
 * the counts survive.
 *
 * ── AND ROUTING STOPS, WHICH NOBODY WOULD GUESS ──
 * The canvas node pointing at the employee is neutralised. Without that, new
 * conversations would keep being routed to a deleted employee indefinitely.
 * It is the one effect a merchant cannot see and would never predict.
 */
export function DeleteEmployee({ employee }: { readonly employee: Employee }) {
  const t = useTranslations('employees');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [released, setReleased] = useState<number | null>(null);

  const finished = finishedConversations(employee);

  if (released !== null) {
    /*
     * The RESULT, not the prediction. The dialog forecast how many people
     * were mid-conversation; this is how many the database actually released.
     *
     * They can legitimately differ: the forecast excludes sandbox rows and
     * setup rehearsals, the release does not. So the server's number is shown
     * rather than the screen insisting its own was right.
     */
    return (
      <p className={styles.deleted} data-testid={`deleted-${employee.id}`}>
        {t('deleted.done', { name: employee.name, released })}
      </p>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.delete}
        data-testid={`delete-${employee.id}`}
        onClick={() => setConfirming(true)}
      >
        {t('action.delete')}
      </button>
    );
  }

  return (
    <div className={styles.confirm} data-testid={`delete-confirm-${employee.id}`}>
      <p className={styles.confirmLead}>{t('delete.lead', { name: employee.name })}</p>

      <ul className={styles.confirmPoints}>
        {/*
          The people. Stated with the count, because "open conversations will
          be affected" does not stop anybody and "14 people are
          mid-conversation" does.
        */}
        <li data-testid={`delete-live-${employee.id}`}>
          {employee.openConversations > 0
            ? t('delete.live', { count: employee.openConversations })
            : t('delete.noneLive')}
        </li>

        {/* The record, which survives - and saying so changes the decision. */}
        {finished > 0 ? (
          <li data-testid={`delete-history-${employee.id}`}>
            {t('delete.historyKept', { count: finished })}
          </li>
        ) : null}

        {/* The effect nobody would guess. */}
        <li data-testid={`delete-routing-${employee.id}`}>{t('delete.routing')}</li>
      </ul>

      {error ? (
        <p className={styles.confirmError} data-testid={`delete-error-${employee.id}`}>
          {error}
        </p>
      ) : null}

      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.deleteConfirm}
          data-testid={`delete-go-${employee.id}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const outcome = await deleteEmployee(employee.id);
            setBusy(false);
            if (!outcome.ok) setError(t(`error.${outcome.reason}` as 'error.failed'));
            else {
              setReleased(outcome.result.releasedConversations);
              setConfirming(false);
              setError(null);
            }
          }}
        >
          {t('action.deleteConfirm')}
        </button>
        <button
          type="button"
          className={styles.keepRunning}
          data-testid={`delete-back-${employee.id}`}
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          {t('action.keepIt')}
        </button>
      </div>
    </div>
  );
}
