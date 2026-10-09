'use client';

import { useTranslations } from 'next-intl';
import { Folder } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';

import {
  disconnectSource,
  FOLDER,
  learnDrive,
  learnSpaces,
  readDriveFiles,
  readDriveSources,
  readIntegrations,
  readSpaces,
  type ConfluenceSpace,
  type DriveFile,
  type DriveSource,
  type KnowledgeIntegration,
} from './sources';
import styles from './AddKnowledge.module.css';
import { SkeletonRows } from '@/design-system/primitives/skeleton/Skeleton';

/**
 * 08b after connecting: each connected Drive or Confluence - what is kept in
 * sync, and a plain list to choose more from. 02 draws no picker, so this is
 * the sheet's own shape: rows and checkboxes. Nothing is learned before
 * "Learn these".
 */
export function ConnectedSources({
  kbId,
  onConnected,
}: {
  readonly kbId: string;
  /** Which providers have an active connection - the rows above say "Connected". */
  readonly onConnected?: (providers: ReadonlySet<string>) => void;
}) {
  const t = useTranslations('knowledge.addSheet.sources');
  const [integrations, setIntegrations] = useState<
    readonly KnowledgeIntegration[] | null | 'loading'
  >('loading');

  useEffect(() => {
    let live = true;
    void readIntegrations(kbId).then((list) => {
      if (!live) return;
      setIntegrations(list);
      onConnected?.(new Set((list ?? []).filter((i) => i.isActive).map((i) => i.provider)));
    });
    return () => {
      live = false;
    };
  }, [kbId, onConnected]);

  // A disconnected source leaves the list, and the rows above stop saying "Connected".
  const gone = (id: string) => {
    if (integrations === null || integrations === 'loading') return;
    const next = integrations.filter((i) => i.id !== id);
    setIntegrations(next);
    onConnected?.(new Set(next.filter((i) => i.isActive).map((i) => i.provider)));
  };

  if (integrations === 'loading')
    return <SkeletonRows label={t('loading')} rows={2} height={48} testid="sources-skeleton" />;
  if (integrations === null) {
    return (
      <p className={styles.problem} data-testid="sources-unread">
        {t('unread')}
      </p>
    );
  }
  const shown = integrations.filter(
    (i) => i.isActive && (i.provider === 'google_drive' || i.provider === 'confluence'),
  );
  if (shown.length === 0) return null;
  return (
    <div className={styles.sources} data-testid="connected-sources">
      {shown.map((i) =>
        i.provider === 'google_drive' ? (
          <DriveSourceCard key={i.id} integration={i} onGone={gone} />
        ) : (
          <ConfluenceCard key={i.id} integration={i} onGone={gone} />
        ),
      )}
    </div>
  );
}

/**
 * Disconnect, confirmed first. What it does is the route's: the connection
 * row is deleted, so the sync stops; the documents it brought are kept.
 */
function SourceDisconnect({
  integration,
  name,
  onGone,
}: {
  readonly integration: KnowledgeIntegration;
  readonly name: string;
  readonly onGone: (id: string) => void;
}) {
  const t = useTranslations('knowledge.addSheet.sources.disconnect');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<'forbidden' | 'failed' | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.sourceBtn}
        data-testid={`source-disconnect-${integration.id}`}
        onClick={() => {
          setProblem(null);
          setConfirming(true);
        }}
      >
        {t('button')}
      </button>
    );
  }
  return (
    <div role="group" aria-label={t('button')} data-testid="source-disconnect-confirm">
      <p className={styles.sourceMeta} data-testid="source-disconnect-what">
        {t('confirm', { name })}
      </p>
      {problem ? (
        <p className={styles.problem} role="alert" data-testid="source-disconnect-problem">
          {t(`problem.${problem}`, { name })}
        </p>
      ) : null}
      <div className={styles.sourceActions}>
        <button
          type="button"
          className={styles.sourceBtnPrimary}
          disabled={isPending}
          data-testid="source-disconnect-yes"
          onClick={() =>
            startTransition(async () => {
              const result = await disconnectSource(integration.id);
              if (result.ok) onGone(integration.id);
              else setProblem(result.reason);
            })
          }
        >
          {isPending ? t('working') : t('yes')}
        </button>
        <button
          type="button"
          className={styles.sourceBtn}
          disabled={isPending}
          onClick={() => setConfirming(false)}
        >
          {t('keep')}
        </button>
      </div>
    </div>
  );
}

function DriveSourceCard({
  integration,
  onGone,
}: {
  readonly integration: KnowledgeIntegration;
  readonly onGone: (id: string) => void;
}) {
  const t = useTranslations('knowledge.addSheet.sources');
  const [sources, setSources] = useState<readonly DriveSource[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [path, setPath] = useState<readonly DriveFile[]>([]);
  const [files, setFiles] = useState<readonly DriveFile[] | null | 'loading'>('loading');
  const [picked, setPicked] = useState<readonly DriveFile[]>([]);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const folderId = path.at(-1)?.id;

  useEffect(() => {
    let live = true;
    void readDriveSources(integration.id).then((s) => {
      if (live) setSources(s);
    });
    return () => {
      live = false;
    };
  }, [integration.id]);

  useEffect(() => {
    if (!browsing) return;
    let live = true;
    void readDriveFiles(integration.id, folderId).then((f) => {
      if (live) setFiles(f);
    });
    return () => {
      live = false;
    };
  }, [browsing, integration.id, folderId]);

  // The route takes folders or files, not both at once: the other kind waits.
  const pickedKind =
    picked.length === 0 ? null : picked[0]!.mimeType === FOLDER ? 'folder' : 'file';
  const toggle = (f: DriveFile) =>
    setPicked((now) =>
      now.some((p) => p.id === f.id) ? now.filter((p) => p.id !== f.id) : [...now, f],
    );

  return (
    <section className={styles.sourceCard} data-testid={`source-${integration.id}`}>
      <p className={styles.sourceHead}>
        <span>{t('drive', { name: integration.displayName ?? t('driveName') })}</span>
      </p>
      {sources && sources.length > 0 ? (
        <ul className={styles.sourceList} data-testid="drive-synced">
          {sources.map((s) => (
            <li key={s.key}>
              {s.name}
              <span className={styles.sourceMeta}>
                {s.paused ? t('paused') : s.kind === 'folder' ? t('folderSynced') : t('fileSynced')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {said ? (
        <p
          className={said.ok ? styles.sourceDone : styles.problem}
          role={said.ok ? 'status' : 'alert'}
        >
          {said.text}
        </p>
      ) : null}
      {!browsing ? (
        <button
          type="button"
          className={styles.sourceBtn}
          data-testid="drive-choose"
          onClick={() => {
            setSaid(null);
            setFiles('loading');
            setBrowsing(true);
          }}
        >
          {t('choose')}
        </button>
      ) : (
        <>
          <p className={styles.sourceSection} data-testid="drive-browsing">
            {path.at(-1)?.name ?? t('choose')}
          </p>
          {path.length > 0 ? (
            <button
              type="button"
              className={styles.sourceBack}
              data-testid="drive-up"
              onClick={() => {
                setFiles('loading');
                setPath(path.slice(0, -1));
              }}
            >
              ‹ {path.length > 1 ? path.at(-2)!.name : t('root')}
            </button>
          ) : null}
          {files === 'loading' ? (
            <SkeletonRows label={t('loading')} rows={4} height={40} testid="drive-skeleton" />
          ) : files === null ? (
            <p className={styles.problem} data-testid="drive-unread">
              {t('filesUnread')}
            </p>
          ) : files.length === 0 ? (
            <p className={styles.sourceMeta}>{t('empty')}</p>
          ) : (
            <ul className={styles.sourceList} data-testid="drive-files">
              {files.map((f) => {
                const folder = f.mimeType === FOLDER;
                const otherKind =
                  pickedKind !== null && pickedKind !== (folder ? 'folder' : 'file');
                return (
                  <li key={f.id}>
                    <label title={otherKind ? t('oneKind') : undefined}>
                      <input
                        type="checkbox"
                        checked={picked.some((p) => p.id === f.id)}
                        disabled={otherKind}
                        data-testid={`drive-pick-${f.id}`}
                        onChange={() => toggle(f)}
                      />
                      {folder ? (
                        <Folder size={14} aria-hidden="true" className={styles.folderMark} />
                      ) : null}
                      {f.name}
                    </label>
                    {folder ? (
                      <button
                        type="button"
                        className={styles.sourceOpen}
                        data-testid={`drive-open-${f.id}`}
                        onClick={() => {
                          setFiles('loading');
                          setPath([...path, f]);
                        }}
                      >
                        {t('open')}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className={styles.sourceActions}>
            <button
              type="button"
              className={styles.sourceBtnPrimary}
              disabled={isPending || picked.length === 0}
              data-testid="drive-learn"
              onClick={() =>
                startTransition(async () => {
                  const result = await learnDrive(integration.id, picked);
                  if (result.ok) {
                    setSaid({ ok: true, text: t('learning', { count: picked.length }) });
                    setPicked([]);
                    setBrowsing(false);
                    setSources(await readDriveSources(integration.id));
                  } else {
                    setSaid({ ok: false, text: t(`refused.${result.reason}`) });
                  }
                })
              }
            >
              {t('learn', { count: picked.length })}
            </button>
            <button
              type="button"
              className={styles.sourceBtn}
              onClick={() => {
                setBrowsing(false);
                setPicked([]);
                setPath([]);
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </>
      )}
      <SourceDisconnect
        integration={integration}
        name={integration.displayName ?? t('driveName')}
        onGone={onGone}
      />
    </section>
  );
}

function ConfluenceCard({
  integration,
  onGone,
}: {
  readonly integration: KnowledgeIntegration;
  readonly onGone: (id: string) => void;
}) {
  const t = useTranslations('knowledge.addSheet.sources');
  const [spaces, setSpaces] = useState<readonly ConfluenceSpace[] | null | 'loading'>('loading');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    void readSpaces(integration.id).then((s) => {
      if (live) setSpaces(s);
    });
    return () => {
      live = false;
    };
  }, [integration.id]);

  return (
    <section className={styles.sourceCard} data-testid={`source-${integration.id}`}>
      <p className={styles.sourceHead}>
        {t('confluence', { name: integration.displayName ?? 'Confluence' })}
      </p>
      {spaces === 'loading' ? (
        <p className={styles.sourceMeta}>{t('loading')}</p>
      ) : spaces === null ? (
        <p className={styles.problem}>{t('spacesUnread')}</p>
      ) : (
        <ul className={styles.sourceList} data-testid="confluence-spaces">
          {spaces.map((s) => (
            <li key={s.key}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(s.key)}
                  data-testid={`space-pick-${s.key}`}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(s.key)) next.delete(s.key);
                    else next.add(s.key);
                    setPicked(next);
                  }}
                />
                {s.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {said ? (
        <p
          className={said.ok ? styles.sourceDone : styles.problem}
          role={said.ok ? 'status' : 'alert'}
        >
          {said.text}
        </p>
      ) : null}
      <div className={styles.sourceActions}>
        <button
          type="button"
          className={styles.sourceBtnPrimary}
          disabled={isPending || picked.size === 0}
          data-testid="confluence-learn"
          onClick={() =>
            startTransition(async () => {
              const result = await learnSpaces(integration.id, [...picked]);
              setSaid(
                result.ok
                  ? { ok: true, text: t('learnedSpaces', { count: picked.size }) }
                  : { ok: false, text: t(`refused.${result.reason}`) },
              );
              if (result.ok) setPicked(new Set());
            })
          }
        >
          {t('learnSpaces', { count: picked.size })}
        </button>
      </div>
      <SourceDisconnect
        integration={integration}
        name={integration.displayName ?? 'Confluence'}
        onGone={onGone}
      />
    </section>
  );
}
