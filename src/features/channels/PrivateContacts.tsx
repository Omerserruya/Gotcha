'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';

import type { Exclusion } from '@/api/contracts/whatsapp-numbers';
import { useRouter } from '@/i18n/navigation';

import { addPrivateContact, removePrivateContact, type AddContactResult } from './number-actions';
import styles from './Channels.module.css';

/** The route's own minimum - a rule matching nothing is worse than none. */
export const MIN_DIGITS = 6;
const PHONE_CHARS = /^[\d\s()+.-]+$/;

/** What the route will take: phone characters only, and at least six digits. */
export function looksLikeNumber(value: string): boolean {
  const v = value.trim();
  return PHONE_CHARS.test(v) && v.replace(/\D/g, '').length >= MIN_DIGITS;
}

/**
 * 13b · Private contacts, live (Omer, 2026-10-07): add a number (and a note
 * if they like) GOTCHA should leave alone, or remove one - a short "are you
 * sure", since it starts reaching GOTCHA again. Adding a number already
 * there updates its note (the route upserts).
 */
export function PrivateContacts({ exclusions }: { readonly exclusions: readonly Exclusion[] }) {
  const t = useTranslations('channels.whatsapp.tabs.contacts');
  const router = useRouter();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<
    Exclude<AddContactResult, { ok: true }>['reason'] | 'format' | null
  >(null);
  const [adding, startAdd] = useTransition();
  const [asking, setAsking] = useState<string | null>(null);
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);
  const [removing, startRemove] = useTransition();

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!looksLikeNumber(value)) {
      setProblem('format');
      return;
    }
    startAdd(async () => {
      setProblem(null);
      const result = await addPrivateContact({ value, note, channelAccountId: null });
      if (!result.ok) {
        setProblem(result.reason);
        return;
      }
      setValue('');
      setNote('');
      router.refresh();
    });
  };

  return (
    <>
      <p className={styles.tabNote} data-testid={exclusions.length > 0 ? undefined : 'tab-empty'}>
        {exclusions.length > 0 ? t('lead') : t('none')}
      </p>
      {exclusions.length > 0 ? (
        <ul className={styles.tabList} data-testid="tab-contacts">
          {exclusions.map((rule) => (
            <li key={rule.id} className={styles.tabRow} data-testid={`tab-contact-${rule.id}`}>
              <bdi dir="ltr" className={styles.tabRowName}>
                {rule.value}
              </bdi>
              {rule.note ? (
                <bdi dir="auto" className={styles.tabRowMeta}>
                  {rule.note}
                </bdi>
              ) : null}
              {asking === rule.id ? (
                <span className={styles.rowConfirm} role="alert">
                  {t('removeConfirm', { number: rule.value })}{' '}
                  <button
                    type="button"
                    className={styles.confirmKeep}
                    onClick={() => setAsking(null)}
                  >
                    {t('keep')}
                  </button>
                  <button
                    type="button"
                    className={styles.confirmDanger}
                    disabled={removing}
                    onClick={() =>
                      startRemove(async () => {
                        setRemoveFailed(null);
                        const result = await removePrivateContact(rule.id);
                        if (!result.ok) {
                          setRemoveFailed(rule.id);
                          return;
                        }
                        setAsking(null);
                        router.refresh();
                      })
                    }
                    data-testid={`contact-remove-yes-${rule.id}`}
                  >
                    {t('removeYes')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.rowRemove}
                  onClick={() => {
                    setRemoveFailed(null);
                    setAsking(rule.id);
                  }}
                  data-testid={`contact-remove-${rule.id}`}
                >
                  {t('remove')}
                </button>
              )}
              {removeFailed === rule.id ? (
                <span className={styles.footProblem} role="alert">
                  {t('removeFailed')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form className={styles.contactForm} onSubmit={add} data-testid="contact-add">
        <label className={styles.contactField}>
          <span>{t('numberLabel')}</span>
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setProblem(null);
            }}
            inputMode="tel"
            dir="ltr"
            placeholder={t('numberPlaceholder')}
            aria-invalid={problem === 'format' || problem === 'invalid_number'}
            data-testid="contact-number"
          />
        </label>
        <label className={styles.contactField}>
          <span>{t('noteLabel')}</span>
          <input
            value={note}
            maxLength={280}
            onChange={(e) => setNote(e.target.value)}
            dir="auto"
            placeholder={t('notePlaceholder')}
            data-testid="contact-note"
          />
        </label>
        <button
          type="submit"
          className={styles.contactAdd}
          disabled={adding || value.trim() === ''}
          data-testid="contact-add-submit"
        >
          {adding ? t('adding') : t('add')}
        </button>
        {problem ? (
          <p className={styles.footProblem} role="alert" data-testid="contact-add-problem">
            {t(`problem.${problem}`, { min: MIN_DIGITS })}
          </p>
        ) : null}
      </form>
    </>
  );
}
