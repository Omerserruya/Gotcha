'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { emailProblem, whatsappIdOf } from './add-customer';
import { addCustomer, type AddCustomerResult } from './customer-actions';
import styles from './Customers.module.css';

/**
 * 04's "Add a customer" — live (Omer, 2026-10-04). Name and phone, email if
 * known; the person is created as the WhatsApp identity they write from, or
 * — when the phone is already here — the existing person opens instead.
 */
export function AddCustomer() {
  const t = useTranslations('customers.add');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const phoneBad = phone.trim() !== '' && whatsappIdOf(phone) === null;
  const emailBad = emailProblem(email);

  function submit() {
    setProblem(null);
    startTransition(async () => {
      const result: AddCustomerResult = await addCustomer({ name, phone, email });
      if (result.ok) {
        setOpen(false);
        router.push(`/customers/${result.id}`);
        return;
      }
      setProblem(t(`problem.${result.reason}`));
    });
  }

  return (
    <div className={styles.addWrap}>
      <button
        type="button"
        className={styles.addCustomer}
        aria-expanded={open}
        data-testid="add-customer"
        onClick={() => setOpen(!open)}
      >
        {t('label')}
      </button>
      {open ? (
        <div
          className={styles.addPanel}
          role="dialog"
          aria-label={t('label')}
          data-testid="add-panel"
        >
          <label className={styles.addField}>
            <span>{t('name')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="add-name"
              autoComplete="off"
            />
          </label>
          <label className={styles.addField}>
            <span>{t('phone')}</span>
            <input
              value={phone}
              inputMode="tel"
              aria-invalid={phoneBad}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="054-123 4567"
              data-testid="add-phone"
            />
          </label>
          {phoneBad ? (
            <p className={styles.addProblem} data-testid="add-phone-problem">
              {t('problem.phone')}
            </p>
          ) : null}
          <label className={styles.addField}>
            <span>{t('email')}</span>
            <input
              value={email}
              type="email"
              aria-invalid={emailBad}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="add-email"
            />
          </label>
          <p className={styles.addNote}>{t('note')}</p>
          {problem ? (
            <p className={styles.addProblem} role="alert" data-testid="add-problem">
              {problem}
            </p>
          ) : null}
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.dupePrimary}
              disabled={isPending || !name.trim() || !phone.trim() || phoneBad || emailBad}
              data-testid="add-submit"
              onClick={submit}
            >
              {t('submit')}
            </button>
            <button type="button" className={styles.dupeSecondary} onClick={() => setOpen(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
