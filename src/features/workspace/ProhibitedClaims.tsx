'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { saveProhibitedClaims } from './actions';
import styles from './Workspace.module.css';

/**
 * "Never say" — hard constraints, listed plainly.
 *
 * These are already enforced: the prompt builder reads the same list and the
 * AI obeys it. This screen is the first thing that can author one.
 *
 * The API replaces the whole list, so add and remove are edits to a local list
 * followed by one write. The list is applied optimistically and put back on
 * failure — a rule that vanished from the screen but not from the AI would be
 * the worst outcome here, so the screen never claims a removal it did not get.
 *
 * TWO DIFFERENT SERVER BEHAVIOURS, and conflating them was a real bug here:
 *
 *   - blanks and case-duplicates are dropped SILENTLY, 200 with a shorter
 *     array. So the returned list is rendered, never the submitted one.
 *   - 50 items and 200 characters are HARD LIMITS. Over either and the whole
 *     save is rejected 422 with nothing written — not trimmed. So the UI
 *     enforces both itself: a pasted 201-character rule must be stopped here,
 *     because the server's answer is to discard the entire list.
 *
 * (An earlier comment recorded all four as trimming. Corrected in S11-v1.1.)
 */
const MAX_CLAIMS = 50;
const MAX_CLAIM_LENGTH = 200;
export function ProhibitedClaims({ claims }: { claims: readonly string[] }) {
  const t = useTranslations('workspace.claims');
  const tRoot = useTranslations('workspace');
  const [list, setList] = useState<readonly string[]>(claims);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  function write(next: readonly string[], previous: readonly string[]) {
    setList(next);
    setStatus(null);
    setIsError(false);
    startTransition(async () => {
      const result = await saveProhibitedClaims(next);
      if (result.ok) {
        setList(result.data.claims);
        setStatus(tRoot('saved'));
        return;
      }
      // Put it back. A rule the screen dropped but the AI still enforces is
      // worse than one that visibly refused to save.
      setList(previous);
      setIsError(true);
      setStatus(
        result.reason === 'invalid'
          ? (Object.values(result.fields)[0] ?? tRoot('failed'))
          : tRoot('failed'),
      );
    });
  }

  const isFull = list.length >= MAX_CLAIMS;

  function add() {
    const value = draft.trim();
    // Over either limit the server rejects the WHOLE list, so neither can be
    // allowed to leave this function.
    if (!value || isFull || value.length > MAX_CLAIM_LENGTH) return;
    setDraft('');
    write([...list, value], list);
  }

  return (
    <section>
      <p className={styles.sectionTitle}>{t('title')}</p>

      <div className={styles.claims} data-testid="claims-list">
        {list.length === 0 ? <p className={styles.claim}>{t('empty')}</p> : null}

        {list.map((claim, index) => (
          <div key={`${claim}-${index}`} className={styles.claim}>
            <span className={styles.claimText}>{claim}</span>
            <button
              type="button"
              className={styles.claimRemove}
              disabled={isPending}
              onClick={() =>
                write(
                  list.filter((_, i) => i !== index),
                  list,
                )
              }
            >
              {t('remove')}
            </button>
          </div>
        ))}

        <div className={styles.claimAdd} data-testid="claims-add">
          <Input
            label={t('newRule')}
            value={draft}
            placeholder={t('placeholder')}
            maxLength={MAX_CLAIM_LENGTH}
            disabled={isFull}
            hint={isFull ? t('full', { max: MAX_CLAIMS }) : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          {/*
            `addAction`, not `add`. The field's label and this button both
            read `t('add')` and both rendered "Add a rule", one above the
            other — a label naming the thing and a button naming the verb are
            not the same string, and using one key for both guarantees they
            can never differ.

            It survived three rebuilds because nothing asserted it. A
            duplicate label is invisible to a type checker, to a test that
            queries by role, and to a reader who knows what it meant to say.
          */}
          <Button size="sm" onClick={add} disabled={isPending || isFull || !draft.trim()}>
            {t('addAction')}
          </Button>
        </div>
      </div>

      {status ? (
        <p className={[styles.status, isError ? styles.statusError : ''].join(' ').trim()}>
          {status}
        </p>
      ) : null}
    </section>
  );
}
