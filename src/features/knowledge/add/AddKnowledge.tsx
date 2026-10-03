'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import hire from '@/features/employees/hire/Hire.module.css';
import { Link } from '@/i18n/navigation';

import styles from './AddKnowledge.module.css';

/**
 * The ways in 08b offers, each the `sourceType` it would write.
 *
 * 02's sixth card, "Your product catalogue", is not here: Omer ruled
 * (2026-09-26) that the catalogue is not a knowledge source — it is 14's
 * part→system mapping.
 */
export const ADD_WAYS = ['document', 'page', 'drive', 'text', 'conversation'] as const;
export type AddWay = (typeof ADD_WAYS)[number];

/** 02's eyebrow over each card. */
const EYEBROW: Record<AddWay, 'upload' | 'website' | 'drive' | 'conversations'> = {
  document: 'upload',
  page: 'website',
  drive: 'drive',
  text: 'upload',
  conversation: 'conversations',
};

export function isAddWay(value: string | undefined): value is AddWay {
  return (ADD_WAYS as readonly string[]).includes(value ?? '');
}

/**
 * 08b, measured: "Add knowledge" — an 860 dialog over 08. The ways in as
 * cards, the chosen one's form under them, then "What it learned" and
 * "Teach all of it".
 *
 * Read-only, as Hire is: adding writes a source and runs extraction and
 * embedding, so every control that would send is drawn, not live, with
 * its reason. Choosing a way and typing are local.
 *
 *   document       `POST …/documents/upload` — PDF, Word, Markdown or
 *                  text, up to 10 MB (`file-parser.service.ts`)
 *   page           `POST …/documents`, `sourceType: "url"`
 *   drive          Google Drive or Confluence (`knowledge-oauth.ts`) —
 *                  not Dropbox, which the platform has no connector for
 *   text           `POST …/documents`, `sourceType: "text"`
 *   conversation   nothing pins one answer; past conversations come in
 *                  through the history import on 13
 *
 * ── DRAWN, AND WHY ──
 *   What it learned   nothing previews the facts a source teaches, or
 *                     classifies them against what is known, before it
 *                     is added
 */
export function AddKnowledge({ initialWay = 'document' }: { readonly initialWay?: AddWay }) {
  const t = useTranslations('knowledge.addSheet');
  const [way, setWay] = useState<AddWay>(initialWay);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  return (
    <div className={hire.layer} data-testid="add-sheet" data-way={way}>
      <Link
        href="/studio/knowledge"
        className={hire.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section className={styles.dialog} aria-label={t('title')}>
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 className={styles.title}>{t('title')}</h2>
            <p className={styles.line}>{t('line')}</p>
          </div>
          <Link
            href="/studio/knowledge"
            className={hire.close}
            aria-label={t('close')}
            scroll={false}
          >
            <X size={16} aria-hidden="true" />
          </Link>
        </header>

        <div className={styles.ways} role="radiogroup" aria-label={t('title')}>
          {ADD_WAYS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={way === w}
              className={styles.way}
              data-testid={`add-way-${w}`}
              onClick={() => setWay(w)}
            >
              <span className={styles.eyebrow}>{t(`eyebrow.${EYEBROW[w]}`)}</span>
              <span className={styles.wayName}>{t(`way.${w}.name`)}</span>
              <span className={styles.wayText}>{t(`way.${w}.text`)}</span>
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {way === 'document' ? (
            <div
              className={styles.drop}
              aria-disabled="true"
              title={t('notYet')}
              data-testid="add-drop"
            >
              {t('drop')}
            </div>
          ) : way === 'page' ? (
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="url"
                inputMode="url"
                placeholder={t('urlPlaceholder')}
                aria-label={t('way.page.name')}
                value={url}
                data-testid="add-url"
                onChange={(e) => setUrl(e.target.value)}
              />
              <span
                role="button"
                className={styles.go}
                aria-disabled="true"
                title={t('notYet')}
                data-testid="add-read"
              >
                {t('read')}
              </span>
            </div>
          ) : way === 'drive' ? (
            <ul className={styles.connectors}>
              {(['google_drive', 'confluence'] as const).map((c) => (
                <li key={c} className={styles.connector}>
                  <span>{t(`connector.${c}`)}</span>
                  <span
                    role="button"
                    className={styles.small}
                    aria-disabled="true"
                    title={t('notYet')}
                    data-testid={`add-connect-${c}`}
                  >
                    {t('connect')}
                  </span>
                </li>
              ))}
            </ul>
          ) : way === 'text' ? (
            <div className={styles.form}>
              <input
                className={styles.input}
                placeholder={t('titlePlaceholder')}
                aria-label={t('titlePlaceholder')}
                value={title}
                data-testid="add-title"
                onChange={(e) => setTitle(e.target.value)}
              />
              <textarea
                className={styles.input}
                rows={3}
                placeholder={t('bodyPlaceholder')}
                aria-label={t('bodyPlaceholder')}
                value={body}
                data-testid="add-body"
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          ) : (
            <p className={styles.none} title={t('pinNone')} data-testid="add-pin">
              —
            </p>
          )}

          <section className={styles.learned} data-testid="add-learned">
            <header className={styles.learnedHead}>
              <h3 className={styles.learnedTitle}>{t('learned')}</h3>
              <span className={styles.meta}>—</span>
            </header>
            <p className={styles.learnedNone} title={t('learnedNone')}>
              —
            </p>
          </section>

          <div className={styles.foot}>
            <span
              role="button"
              className={styles.primary}
              aria-disabled="true"
              title={t('notYet')}
              data-testid="add-teach"
            >
              {t('teach')}
            </span>
            <Link href="/studio/knowledge" className={styles.cancel} scroll={false}>
              {t('cancel')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
