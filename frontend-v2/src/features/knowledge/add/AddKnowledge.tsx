'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import hire from '@/features/employees/hire/Hire.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import {
  addKnowledge,
  DOCUMENT_TYPES,
  documentProblem,
  pageAddress,
  startKnowledgeConnect,
  type AddInput,
  type AddResult,
  type KnowledgeLanding,
} from './add-knowledge';
import { ADD_WAYS, EYEBROW, type AddWay, type KnowledgeBaseRef } from './add-way';
import { ConnectedSources } from './ConnectedSources';
import styles from './AddKnowledge.module.css';

/**
 * 08b, measured: "Add knowledge" - an 860 dialog over 08. The ways in as
 * cards, the chosen one's form under them, then "What it learned" and
 * "Teach all of it".
 *
 * LIVE for a document, a page and a typed fact (Omer, 2026-10-04): each
 * writes a document into the tenant's knowledge and the platform reads and
 * embeds it in the background - so what comes back is "being read", never
 * "learned". Nothing is sent without the button. Drive and Confluence connect at
 * Google or Atlassian and come back here (backend df9ee4cd).
 *
 *   document       `POST …/documents/upload` - PDF, Word, Markdown or
 *                  text, up to 10 MB (`file-parser.service.ts`)
 *   page           `POST …/documents`, `sourceType: "url"`
 *   drive          Google Drive or Confluence (`knowledge-oauth.ts`) -
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
  landing = null,
}: {
  readonly initialWay?: AddWay;
  /** Where it goes: a base, `none` yet (one is made), or `unknown` (the read failed). */
  readonly base?: KnowledgeBaseRef;
  /** The way back from Google or Atlassian (backend df9ee4cd), when this render is one. */
  readonly landing?: KnowledgeLanding | null;
}) {
  const t = useTranslations('knowledge.addSheet');
  const router = useRouter();
  /*
    ★ Held in state from the first render: tidying the URL re-renders the page
    without the query, and the sentence must outlive that (10's lesson).
  */
  const [said, setSaid] = useState(landing);
  const arrived = landing !== null;
  useEffect(() => {
    if (arrived) {
      router.replace(
        { pathname: '/studio/knowledge', query: { add: '1', way: 'drive' } },
        { scroll: false },
      );
    }
  }, [arrived, router]);
  const [connecting, setConnecting] = useState<'google_drive' | 'confluence' | null>(null);
  const [connectedProviders, setConnectedProviders] = useState<ReadonlySet<string>>(new Set());
  const [connectProblem, setConnectProblem] = useState<string | null>(null);
  function connect(connector: 'google_drive' | 'confluence') {
    setConnectProblem(null);
    setConnecting(connector);
    startTransition(async () => {
      const start = await startKnowledgeConnect(base, connector, t('newBase'));
      if (start.ok) {
        window.location.assign(start.url);
        return;
      }
      setConnecting(null);
      setConnectProblem(t(`connectProblem.${start.reason}`, { name: t(`connector.${connector}`) }));
    });
  }
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
            <>
              {said ? (
                <p
                  className={styles.landing}
                  role="status"
                  data-outcome={said.outcome === 'connected' ? 'ok' : 'problem'}
                  data-testid="add-landing"
                >
                  <span>
                    {t(`landing.${said.outcome}`, {
                      name: t(`connector.${said.connector}`),
                      provider: t(`provider.${said.connector}`),
                    })}
                  </span>
                  <button
                    type="button"
                    className={styles.landingClose}
                    aria-label={t('landing.close')}
                    onClick={() => setSaid(null)}
                  >
                    ×
                  </button>
                </p>
              ) : null}
              {/* Live (backend df9ee4cd): at the provider, and back here. */}
              <ul className={styles.connectors}>
                {(['google_drive', 'confluence'] as const).map((c) => (
                  <li key={c} className={styles.connector}>
                    <span className={styles.connectorName}>
                      <IntegrationLogo slug={c} size="rail" />
                      {t(`connector.${c}`)}
                    </span>
                    {connectedProviders.has(c) ? (
                      // Connected already: said, and another account is a quiet link.
                      <span className={styles.connectedMark} data-testid={`add-connected-${c}`}>
                        {t('connectedAlready')} ·{' '}
                        <button
                          type="button"
                          className={styles.linkish}
                          disabled={isPending}
                          data-testid={`add-connect-${c}`}
                          onClick={() => connect(c)}
                        >
                          {t('addAnother')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.small}
                        disabled={isPending}
                        data-testid={`add-connect-${c}`}
                        onClick={() => connect(c)}
                      >
                        {connecting === c ? t('opening') : t('connect')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {connectProblem ? (
                <p className={styles.problem} role="alert" data-testid="add-connect-problem">
                  {connectProblem}
                </p>
              ) : null}
              {/* After connecting: what each source holds, and choosing what to learn. */}
              {typeof base === 'object' ? (
                <ConnectedSources kbId={base.id} onConnected={setConnectedProviders} />
              ) : null}
            </>
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
              -
            </p>
          )}

          {/*
            "What it learned": the platform previews nothing before a source
            is added, and reads it in the background after - so this says
            what was added and that it is being read, never what it learned.
          */}
          <section className={styles.learned} data-testid="add-learned">
            <header className={styles.learnedHead}>
              <h3 className={styles.learnedTitle}>{t('learned')}</h3>
              <span className={styles.meta}>-</span>
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
                -
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
