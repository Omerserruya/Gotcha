'use client';

import { useTranslations } from 'next-intl';
import { useDeferredValue, useId, useRef, useState, useTransition, type ChangeEvent } from 'react';

import type { EmailTemplate, RemovedKind } from '@/api/contracts/email-template';
import { Button } from '@/design-system/primitives/button/Button';
import { useRouter } from '@/i18n/navigation';

import {
  saveEmailTemplate,
  sendEmailTemplateTest,
  type SaveTemplateRefusal,
  type TestSendResult,
} from './email-template-actions';
import {
  CONTENT_PLACEHOLDER,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_PLACEHOLDERS,
  isHtmlFile,
  placeholderChip,
  previewContentBlock,
  previewDocument,
  templateBytes,
  templateProblem,
} from './email-template';
import styles from './EmailTemplate.module.css';

/** The catalogue's key for each kind the sanitiser can remove. */
const REMOVED_KEY: Readonly<Record<RemovedKind, string>> = {
  script: 'script',
  iframe: 'iframe',
  object: 'object',
  embed: 'embed',
  form: 'form',
  'on*': 'onHandlers',
  'javascript:': 'javascriptLinks',
};

type Notice =
  | { readonly kind: 'saved'; readonly removed: readonly RemovedKind[] }
  | { readonly kind: 'saveProblem'; readonly reason: SaveTemplateRefusal }
  | { readonly kind: 'uploadProblem'; readonly reason: 'notHtml' | 'tooLarge' | 'failed' }
  | null;

/**
 * One mailbox's HTML template: the switch, the editor, the placeholders, a
 * live preview and a test send (Omer, 2026-10-22).
 *
 * ★ THE PASTED HTML NEVER ENTERS THIS PAGE'S DOM. It is shown only through a
 *   sandboxed iframe's `srcdoc` with an EMPTY `sandbox`: no scripts, no
 *   same-origin, no forms, no top navigation. The editor holds it as text.
 *
 * ★ THE SWITCH SENDS `enabled` ALONE, so turning it on or off never re-sends
 *   (or drops) the stored html - unsaved edits stay in the editor, unsaved.
 *
 * ★ THE TEST SENDS WHAT IS STORED, so it is offered only when nothing is
 *   unsaved: otherwise "send a test" would mail a template the screen is not
 *   showing.
 */
export function EmailTemplateEditor({
  channelId,
  stored,
  names,
}: {
  readonly channelId: string;
  readonly stored: EmailTemplate;
  /** Real values for the preview; `null` is drawn as the placeholder's chip. */
  readonly names: { readonly agent: string | null; readonly business: string | null };
}) {
  const t = useTranslations('channels.emailTemplate');
  const router = useRouter();
  const [saved, setSaved] = useState(stored);
  const [html, setHtml] = useState(stored.html ?? '');
  const [notice, setNotice] = useState<Notice>(null);
  const [test, setTest] = useState<TestSendResult | null>(null);
  const [saving, startSave] = useTransition();
  const [switching, startSwitch] = useTransition();
  const [sending, startSend] = useTransition();
  const editor = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const ids = { editor: useId(), size: useId(), problem: useId() };

  const problem = templateProblem(html);
  const dirty = html !== (saved.html ?? '');
  const hasStored = saved.html !== null;
  const kb = (bytes: number) => t('kb', { n: (bytes / 1024).toFixed(1) });
  const max = kb(TEMPLATE_MAX_BYTES);
  const bytes = templateBytes(html);

  const preview = useDeferredValue(html);
  const doc =
    preview.trim() === ''
      ? null
      : previewDocument(preview, {
          content: previewContentBlock(t('preview.content')),
          values: {
            ...(names.agent ? { agent_name: names.agent } : {}),
            ...(names.business ? { business_name: names.business } : {}),
          },
          chip: placeholderChip,
        });

  const edit = (next: string) => {
    setHtml(next);
    setNotice(null);
    setTest(null);
  };

  const insert = (name: string) => {
    const field = editor.current;
    const token = `{{${name}}}`;
    const start = field?.selectionStart ?? html.length;
    const end = field?.selectionEnd ?? html.length;
    edit(html.slice(0, start) + token + html.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // Choosing the same file again must read it again.
    event.target.value = '';
    if (!chosen) return;
    if (!isHtmlFile(chosen.name)) return setNotice({ kind: 'uploadProblem', reason: 'notHtml' });
    if (chosen.size > TEMPLATE_MAX_BYTES) {
      return setNotice({ kind: 'uploadProblem', reason: 'tooLarge' });
    }
    try {
      edit(await chosen.text());
    } catch {
      setNotice({ kind: 'uploadProblem', reason: 'failed' });
    }
  };

  const save = () =>
    startSave(async () => {
      const done = await saveEmailTemplate(channelId, { enabled: saved.enabled, html });
      if (!done.ok) return setNotice({ kind: 'saveProblem', reason: done.reason });
      setSaved(done.template);
      // What was STORED: the sanitiser may have taken things out.
      setHtml(done.template.html ?? '');
      setNotice({ kind: 'saved', removed: done.removed });
      setTest(null);
      router.refresh();
    });

  const flip = () =>
    startSwitch(async () => {
      setNotice(null);
      const done = await saveEmailTemplate(channelId, { enabled: !saved.enabled });
      if (!done.ok) return setNotice({ kind: 'saveProblem', reason: done.reason });
      // Only the switch: an unsaved edit in the editor stays as it is.
      setSaved(done.template);
      router.refresh();
    });

  const send = () =>
    startSend(async () => {
      setTest(null);
      setTest(await sendEmailTemplateTest(channelId));
    });

  const problemText =
    problem === 'noContent'
      ? t('problem.noContent', { placeholder: CONTENT_PLACEHOLDER })
      : problem === 'tooLarge'
        ? t('problem.tooLarge', { size: kb(bytes), max })
        : null;

  return (
    <div className={styles.panel} data-testid="email-template">
      <p className={styles.lead}>{t('lead', { placeholder: CONTENT_PLACEHOLDER })}</p>

      <div className={styles.switchRow}>
        <button
          type="button"
          role="switch"
          aria-checked={saved.enabled}
          aria-labelledby={`${ids.editor}-switch-label`}
          aria-describedby={`${ids.editor}-switch`}
          className={styles.switch}
          data-on={saved.enabled ? 'yes' : 'no'}
          // Off with nothing stored: turning it on would be refused (EMAIL_TEMPLATE_NOT_SET).
          disabled={switching || (!saved.enabled && !hasStored)}
          onClick={flip}
          data-testid="email-template-switch"
        />
        <span id={`${ids.editor}-switch-label`} className={styles.switchLabel}>
          {t('switch.label')}
        </span>
        <span id={`${ids.editor}-switch`} className={styles.switchState}>
          {!saved.enabled && !hasStored
            ? t('switch.needsTemplate')
            : saved.enabled
              ? t('switch.on')
              : t('switch.off')}
        </span>
      </div>

      <div className={styles.work}>
        <div className={styles.editorColumn}>
          <div className={styles.editorHead}>
            <label htmlFor={ids.editor} className={styles.eyebrow}>
              {t('editor.label')}
            </label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => file.current?.click()}
              data-testid="email-template-upload"
            >
              {t('editor.upload')}
            </Button>
            <input
              ref={file}
              type="file"
              accept=".html,.htm,text/html"
              hidden
              onChange={(event) => void upload(event)}
              data-testid="email-template-file"
            />
          </div>
          <textarea
            id={ids.editor}
            ref={editor}
            className={styles.code}
            dir="ltr"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={html}
            onChange={(event) => edit(event.target.value)}
            aria-invalid={problem !== null && problem !== 'empty'}
            aria-describedby={`${ids.size} ${ids.problem}`}
            data-testid="email-template-html"
          />
          <div className={styles.editorFoot}>
            <span
              id={ids.size}
              className={styles.size}
              data-over={problem === 'tooLarge' ? 'yes' : 'no'}
              data-testid="email-template-size"
            >
              {t('editor.size', { used: kb(bytes), max })}
            </span>
            {dirty ? (
              <span className={styles.unsaved} data-testid="email-template-unsaved">
                {t('editor.unsaved')}
              </span>
            ) : null}
          </div>
          <p
            id={ids.problem}
            className={styles.problem}
            role="status"
            data-testid="email-template-problem"
          >
            {problemText}
          </p>
          <p className={styles.safety}>{t('editor.safety')}</p>
        </div>

        <aside className={styles.placeholders} aria-labelledby={`${ids.editor}-ph`}>
          <h3 id={`${ids.editor}-ph`} className={styles.eyebrow}>
            {t('placeholders.title')}
          </h3>
          <p className={styles.hint}>{t('placeholders.hint')}</p>
          <ul className={styles.placeholderList}>
            {TEMPLATE_PLACEHOLDERS.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className={styles.chip}
                  dir="ltr"
                  onClick={() => insert(name)}
                  data-testid={`email-template-insert-${name}`}
                >
                  {`{{${name}}}`}
                </button>
                {name === 'content' ? (
                  <span className={styles.required}>{t('placeholders.required')}</span>
                ) : null}
                <span className={styles.placeholderWhat}>{t(`placeholders.${name}`)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={save}
          disabled={saving || !dirty || problem !== null}
          data-testid="email-template-save"
        >
          {saving ? t('saving') : t('save')}
        </Button>
        <NoticeLine notice={notice} max={max} />
      </div>

      <section className={styles.previewSection} aria-labelledby={`${ids.editor}-pv`}>
        <h3 id={`${ids.editor}-pv`} className={styles.eyebrow}>
          {t('preview.title')}
        </h3>
        {doc === null ? (
          <p className={styles.previewEmpty} data-testid="email-template-preview-empty">
            {t('preview.empty')}
          </p>
        ) : (
          <iframe
            className={styles.preview}
            title={t('preview.frameTitle')}
            // EMPTY on purpose: no scripts, no same origin, no forms, no navigation.
            sandbox=""
            srcDoc={doc}
            referrerPolicy="no-referrer"
            data-testid="email-template-preview"
          />
        )}
        <p className={styles.hint}>{t('preview.note')}</p>
      </section>

      <section className={styles.testRow}>
        <Button
          onClick={send}
          disabled={sending || dirty || !hasStored}
          data-testid="email-template-test"
        >
          {sending ? t('test.sending') : t('test.button')}
        </Button>
        <p className={styles.hint} data-testid="email-template-test-hint">
          {dirty && hasStored ? t('test.saveFirst') : t('test.hint')}
        </p>
        {test ? (
          <p
            className={test.ok ? styles.done : styles.problem}
            role={test.ok ? 'status' : 'alert'}
            data-testid="email-template-test-result"
          >
            {test.ok
              ? t('test.sent', { address: test.sentTo })
              : test.reason === 'send_failed'
                ? test.detail
                  ? t('test.problem.send_failed', { detail: test.detail })
                  : t('test.problem.send_failedBare')
                : t(`test.problem.${test.reason}`)}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function NoticeLine({ notice, max }: { readonly notice: Notice; readonly max: string }) {
  const t = useTranslations('channels.emailTemplate');
  if (notice === null) return null;
  if (notice.kind === 'saved') {
    return (
      <p className={styles.done} role="status" data-testid="email-template-notice">
        {t('saved')}
        {notice.removed.length > 0 ? (
          <>
            {' '}
            <span data-testid="email-template-removed">
              {t('removed.lead', {
                list: notice.removed
                  .map((kind) => t(`removed.${REMOVED_KEY[kind]}` as 'removed.script'))
                  .join(', '),
              })}
            </span>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <p className={styles.problem} role="alert" data-testid="email-template-notice">
      {notice.kind === 'saveProblem'
        ? t(`saveProblem.${notice.reason}`, { placeholder: CONTENT_PLACEHOLDER, max })
        : notice.reason === 'tooLarge'
          ? t('saveProblem.too_large', { max })
          : t(`upload.${notice.reason}`)}
    </p>
  );
}
