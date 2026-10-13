'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import drawer from '@/design-system/styles/drawer.module.css';
import { useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import {
  deleteDocument,
  saveDocument,
  type DocumentDelete,
  type DocumentSave,
} from './document-actions';
import { documentChange, editNote, editScope, type EditableDocument } from './document-edit';
import styles from './DocumentDrawer.module.css';

type Said =
  | { readonly kind: 'saved'; readonly reprocessing: boolean }
  | { readonly kind: 'save'; readonly reason: Extract<DocumentSave, { ok: false }>['reason'] }
  | { readonly kind: 'delete'; readonly reason: Extract<DocumentDelete, { ok: false }>['reason'] };

/**
 * K11 (Omer, 2026-10-13): edit and delete, in the item's own drawer (K6).
 * The read view is `children` - the server-drawn drawer body - and this owns
 * the foot under it, and the editor that takes its place while editing.
 *
 * ── WHAT CAN BE CHANGED IS WHAT THE PLATFORM KEEPS ──
 * See `document-edit.ts`. Google Drive and Confluence items are kept in step
 * by their sync, which would undo an edit and bring a deleted item back: no
 * control is drawn for them, only where they are changed. An item longer
 * than the drawer holds is edited by its title alone.
 *
 * ── PERMISSION: REFUSED IN WORDS, AS EVERY KNOWLEDGE WRITE ON 08 IS ──
 * The page has no read of the person's permissions (08's Answer, the resolve
 * and the Add sheet all draw their control and say so on a 403). Here too:
 * a 403 says "you need permission", never "failed".
 *
 * Escape or × while editing leaves the drawer and the draft with it - no
 * extra prompt (Omer's brief).
 */
export function DocumentActions({
  document,
  children,
}: {
  readonly document: EditableDocument;
  /** The read view: the drawer's body, drawn by the server. */
  readonly children: ReactNode;
}) {
  const t = useTranslations('knowledge.doc.edit');
  const router = useRouter();
  const scope = editScope(document);
  const note = editNote(document);
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState(document.content ?? '');
  const [said, setSaid] = useState<Said | null>(null);
  const [isPending, startTransition] = useTransition();

  /* Back from the editor or the confirm, focus returns to what opened it. */
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<'edit' | 'delete' | null>(null);
  useEffect(() => {
    if (mode !== 'view' || returnTo.current === null) return;
    (returnTo.current === 'edit' ? editButton : deleteButton).current?.focus();
    returnTo.current = null;
  }, [mode]);

  if (scope.kind === 'synced') {
    return (
      <>
        {children}
        <footer className={drawer.drawerFoot}>
          <p className={styles.footLine} data-testid="doc-synced">
            {t(`synced.${scope.place}`)}
          </p>
        </footer>
      </>
    );
  }

  const change = documentChange(document, { title, content });

  if (mode === 'edit') {
    const problem = said?.kind === 'save' ? said.reason : null;
    return (
      <form
        className={styles.editForm}
        data-testid="doc-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (!change || isPending) return;
          startTransition(async () => {
            const result = await saveDocument(document.knowledgeBaseId, document.id, change);
            if (result.ok) {
              setSaid({ kind: 'saved', reprocessing: result.reprocessing });
              returnTo.current = 'edit';
              setMode('view');
              router.refresh();
            } else {
              setSaid({ kind: 'save', reason: result.reason });
            }
          });
        }}
      >
        <div className={drawer.drawerBody}>
          <label className={drawer.field}>
            <span className={drawer.fieldLabel}>{t('title')}</span>
            <input
              className={drawer.box}
              value={title}
              dir={typedDir(title)}
              // The person just asked to edit it.
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              data-testid="doc-edit-title"
            />
          </label>
          {scope.kind === 'full' ? (
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('content')}</span>
              <textarea
                className={`${drawer.box} ${styles.editContent}`}
                value={content}
                rows={14}
                dir={typedDir(content)}
                onChange={(e) => setContent(e.target.value)}
                data-testid="doc-edit-content"
              />
            </label>
          ) : (
            <p className={drawer.hint} data-testid="doc-edit-title-only">
              {t('titleOnly')}
            </p>
          )}
          {note && (note === 'scan' || scope.kind === 'full') ? (
            <p className={drawer.hint} data-testid="doc-edit-note" data-note={note}>
              {t(`note.${note}`)}
            </p>
          ) : null}
        </div>
        <footer className={drawer.drawerFoot}>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!change || isPending}
            data-testid="doc-edit-save"
          >
            {isPending ? t('saving') : t('save')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setSaid(null);
              returnTo.current = 'edit';
              setMode('view');
            }}
            data-testid="doc-edit-cancel"
          >
            {t('cancel')}
          </Button>
          {problem ? (
            <p className={styles.footSaid} role="alert" data-testid="doc-edit-problem">
              {t(`problem.${problem}`)}
            </p>
          ) : null}
        </footer>
      </form>
    );
  }

  if (mode === 'confirm') {
    const problem = said?.kind === 'delete' ? said.reason : null;
    return (
      <>
        {children}
        <footer
          className={`${drawer.drawerFoot} ${styles.confirmFoot}`}
          role="group"
          aria-label={t('delete')}
          data-testid="doc-delete-confirm"
        >
          <p className={styles.footLine} data-testid="doc-delete-what">
            {t.rich('confirm', {
              title: () => <bdi dir="auto">{document.title}</bdi>,
            })}
          </p>
          <span className={styles.footButtons}>
            <Button
              variant="danger"
              size="sm"
              disabled={isPending}
              data-testid="doc-delete-yes"
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteDocument(document.knowledgeBaseId, document.id);
                  if (result.ok) {
                    // As the drawer's × does: back to the list, which no longer holds it.
                    router.push('/studio/knowledge');
                  } else {
                    setSaid({ kind: 'delete', reason: result.reason });
                  }
                })
              }
            >
              {isPending ? t('deleting') : t('confirmYes')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              // The safe answer has the focus: Enter keeps it.
              autoFocus
              onClick={() => {
                setSaid(null);
                returnTo.current = 'delete';
                setMode('view');
              }}
              data-testid="doc-delete-keep"
            >
              {t('keep')}
            </Button>
          </span>
          {problem ? (
            <p className={styles.footSaid} role="alert" data-testid="doc-delete-problem">
              {t(`deleteProblem.${problem}`)}
            </p>
          ) : null}
        </footer>
      </>
    );
  }

  return (
    <>
      {children}
      <footer className={drawer.drawerFoot}>
        <Button
          ref={editButton}
          size="sm"
          onClick={() => {
            // From what is stored now - the read after a save, not the last draft.
            setTitle(document.title);
            setContent(document.content ?? '');
            setSaid(null);
            setMode('edit');
          }}
          data-testid="doc-edit-open"
        >
          {t('edit')}
        </Button>
        <Button
          ref={deleteButton}
          variant="danger"
          size="sm"
          onClick={() => {
            setSaid(null);
            setMode('confirm');
          }}
          data-testid="doc-delete-open"
        >
          {t('delete')}
        </Button>
        {said?.kind === 'saved' ? (
          <p className={styles.footSaid} role="status" data-testid="doc-saved">
            {said.reprocessing ? t('savedReading') : t('saved')}
          </p>
        ) : null}
      </footer>
    </>
  );
}
