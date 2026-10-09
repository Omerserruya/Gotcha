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

/** One of the workspace's WhatsApp numbers, as a rule can be on it. */
export interface ContactNumber {
  /** Its channel account - what a rule is keyed to. */
  readonly id: string;
  readonly label: string;
}

/**
 * 13b · Private contacts, live (Omer, 2026-10-07): add a number (and a note
 * if they like) GOTCHA should leave alone, or remove one - a short "are you
 * sure", since it starts reaching GOTCHA again.
 *
 * ★ PER WHATSAPP NUMBER (Backend, 2026-10-07): a rule is on one of the
 *   business's numbers - picked when there are several, the one when there
 *   is one. Re-adding on the same number updates the note; on another it is
 *   a separate rule. A rule from before is on every number, and says so.
 */
export function PrivateContacts({
  exclusions,
  numbers,
}: {
  readonly exclusions: readonly Exclusion[];
  /** The numbers a rule can be on; empty when none is connected. */
  readonly numbers: readonly ContactNumber[];
}) {
  const t = useTranslations('channels.whatsapp.tabs.contacts');
  const router = useRouter();
  const [value, setValue] = useState('');
  // One number: it is the one. Several: chosen, never guessed.
  const [on, setOn] = useState(numbers.length === 1 ? numbers[0]!.id : '');
  const onWhich = (rule: Exclusion) =>
    rule.channelAccountId === null
      ? t('allNumbers')
      : (numbers.find((n) => n.id === rule.channelAccountId)?.label ?? t('otherNumber'));
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<
    Exclude<AddContactResult, { ok: true }>['reason'] | 'format' | 'which' | null
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
    if (!on) {
      setProblem('which');
      return;
    }
    startAdd(async () => {
      setProblem(null);
      const result = await addPrivateContact({ value, note, channelAccountId: on });
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
              {/* Which number it is private on - always said for a rule on every number. */}
              {rule.channelAccountId === null || numbers.length > 1 ? (
                <span className={styles.tabRowMeta} data-testid={`tab-contact-on-${rule.id}`}>
                  <bdi dir="auto">{onWhich(rule)}</bdi>
                </span>
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
        {numbers.length > 1 ? (
          <label className={styles.contactField}>
            <span>{t('onLabel')}</span>
            <select
              value={on}
              onChange={(e) => {
                setOn(e.target.value);
                setProblem(null);
              }}
              aria-invalid={problem === 'which' || undefined}
              data-testid="contact-on"
            >
              <option value="" disabled>
                {t('onChoose')}
              </option>
              {numbers.map((number) => (
                <option key={number.id} value={number.id}>
                  {number.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
          disabled={adding || value.trim() === '' || numbers.length === 0}
          data-testid="contact-add-submit"
        >
          {adding ? t('adding') : t('add')}
        </button>
        {numbers.length === 0 ? (
          <p className={styles.tabNote} data-testid="contact-no-numbers">
            {t('noNumbers')}
          </p>
        ) : numbers.length === 1 ? (
          <p className={styles.tabNote} data-testid="contact-on-one">
            {t('onOne', { number: numbers[0]!.label })}
          </p>
        ) : null}
        {problem ? (
          <p className={styles.footProblem} role="alert" data-testid="contact-add-problem">
            {t(`problem.${problem}`, { min: MIN_DIGITS })}
          </p>
        ) : null}
      </form>
    </>
  );
}
