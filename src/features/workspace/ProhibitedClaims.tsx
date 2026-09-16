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
 */
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

  function add() {
    const value = draft.trim();
    if (!value) return;
    setDraft('');
    write([...list, value], list);
  }

  return (
    <section>
      <p className={styles.sectionTitle}>{t('title')}</p>

      <div className={styles.claims}>
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

        <div className={styles.claimAdd}>
          <Input
            label={t('add')}
            value={draft}
            placeholder={t('placeholder')}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button size="sm" onClick={add} disabled={isPending || !draft.trim()}>
            {t('add')}
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
