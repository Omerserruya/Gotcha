'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import hire from '@/features/employees/hire/Hire.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import {
  addKnowledge,
  DOCUMENT_TYPES,
  documentProblem,
  pageAddress,
  type AddInput,
  type AddResult,
} from './add-knowledge';
import { ADD_WAYS, EYEBROW, type AddWay, type KnowledgeBaseRef } from './add-way';
import styles from './AddKnowledge.module.css';

/**
 * 08b, measured: "Add knowledge" — an 860 dialog over 08. The ways in as
 * cards, the chosen one's form under them, then "What it learned" and
 * "Teach all of it".
 *
 * LIVE for a document, a page and a typed fact (Omer, 2026-10-04): each
 * writes a document into the tenant's knowledge and the platform reads and
 * embeds it in the background — so what comes back is "being read", never
 * "learned". Nothing is sent without the button. Drive connects at Google or
 * Atlassian, whose way back leads to the previous app: drawn, with why.
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
export function AddKnowledge({
  initialWay = 'document',
  base = 'unknown',
}: {
  readonly initialWay?: AddWay;
  /** Where it goes: a base, `none` yet (one is made), or `unknown` (the read failed). */
  readonly base?: KnowledgeBaseRef;
}) {
  const t = useTranslations('knowledge.addSheet');
  const router = useRouter();
  const [way, setWay] = useState<AddWay>(initialWay);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<AddResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const input: AddInput | null =
    way === 'document' && file
      ? { way: 'document', file }
      : way === 'page' && pageAddress(url)
        ? { way: 'page', url }
        : way === 'text' && title.trim() && body.trim()
          ? { way: 'text', title, body }
          : null;
  const fileProblem = file ? documentProblem(file) : null;

  function teach() {
    if (input === null) return;
    setResult(null);
    startTransition(async () => {
      const done = await addKnowledge(base, input, t('newBase'));
      setResult(done);
      if (done.ok) {
        setFile(null);
        setUrl('');
        setTitle('');
        setBody('');
        router.refresh();
      }
    });
  }

  const choose = (next: File | null) => {
    setResult(null);
    setFile(next);
  };

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
              onClick={() => {
                setWay(w);
                setResult(null);
              }}
            >
              <span className={styles.eyebrow}>{t(`eyebrow.${EYEBROW[w]}`)}</span>
              <span className={styles.wayName}>{t(`way.${w}.name`)}</span>
              <span className={styles.wayText}>{t(`way.${w}.text`)}</span>
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {way === 'document' ? (
            <label
              className={styles.drop}
              data-testid="add-drop"
              data-has-file={file ? 'yes' : 'no'}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                choose(e.dataTransfer.files[0] ?? null);
              }}
            >
              <input
                type="file"
                className="srOnly"
                accept={DOCUMENT_TYPES.join(',')}
                data-testid="add-file"
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span data-testid="add-file-name">
                  {t('fileChosen', {
                    name: file.name,
                    size: Math.max(1, Math.round(file.size / 1024)),
                  })}
                </span>
              ) : (
                t('drop')
              )}
            </label>
          ) : way === 'page' ? (
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="url"
                inputMode="url"
                dir="ltr"
                placeholder={t('urlPlaceholder')}
                aria-label={t('way.page.name')}
                value={url}
                data-testid="add-url"
                onChange={(e) => {
                  setResult(null);
                  setUrl(e.target.value);
                }}
              />
              <button
                type="button"
                className={styles.go}
                disabled={input === null || isPending}
                data-testid="add-read"
                onClick={teach}
              >
                {isPending ? t('reading') : t('read')}
              </button>
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
                    title={t('driveNotHere', { name: t(`connector.${c}`) })}
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
                onChange={(e) => {
                  setResult(null);
                  setTitle(e.target.value);
                }}
              />
              <textarea
                className={styles.input}
                rows={3}
                placeholder={t('bodyPlaceholder')}
                aria-label={t('bodyPlaceholder')}
                value={body}
                data-testid="add-body"
                onChange={(e) => {
                  setResult(null);
                  setBody(e.target.value);
                }}
              />
            </div>
          ) : (
            <p className={styles.none} title={t('pinNone')} data-testid="add-pin">
              —
            </p>
          )}

          {/*
            "What it learned": the platform previews nothing before a source
            is added, and reads it in the background after — so this says
            what was added and that it is being read, never what it learned.
          */}
          <section className={styles.learned} data-testid="add-learned">
            <header className={styles.learnedHead}>
              <h3 className={styles.learnedTitle}>{t('learned')}</h3>
              <span className={styles.meta}>—</span>
            </header>
            {result?.ok ? (
              <p className={styles.added} data-testid="add-added">
                <span className={styles.addedTitle}>{result.title}</span>
                <span className={styles.meta}>
                  {result.status === 'ready' ? t('state.ready') : t('state.reading')}
                </span>
              </p>
            ) : (
              <p className={styles.learnedNone} title={t('learnedNone')}>
                —
              </p>
            )}
          </section>

          <div className={styles.foot}>
            {way === 'document' || way === 'text' ? (
              <button
                type="button"
                className={styles.primary}
                disabled={input === null || fileProblem !== null || isPending}
                data-testid="add-teach"
                onClick={teach}
              >
                {isPending ? t('teaching') : t('teach')}
              </button>
            ) : null}
            <Link href="/studio/knowledge" className={styles.cancel} scroll={false}>
              {t('cancel')}
            </Link>
            {fileProblem && way === 'document' ? (
              <span className={styles.problem} role="alert" data-testid="add-problem">
                {t(`error.${fileProblem}`)}
              </span>
            ) : result && !result.ok ? (
              <span className={styles.problem} role="alert" data-testid="add-problem">
                {t(`error.${result.reason}`)}
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
