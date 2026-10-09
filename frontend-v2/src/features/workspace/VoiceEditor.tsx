'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import { VOICE_MAX, VOICE_MIN, type WorkspaceVoice } from '@/api/contracts/workspace';
import { Button } from '@/design-system/primitives/button/Button';

import { previewVoiceSample, saveWorkspaceVoice } from './actions';
import styles from './Workspace.module.css';

/**
 * How the business sounds, and what that actually produces.
 *
 * Guidance rather than adjective chips, by decision: the sample is the whole
 * point of the control - "judged by output" - and a chip cannot be judged by
 * anything. Instructions to a writer can.
 *
 * The 40-character minimum is enforced HERE as well as on the server. A round
 * trip that comes back 422 to say "too short" is a worse way to learn a limit
 * than a counter that was showing it the whole time.
 */
export function VoiceEditor({ voice }: { voice: WorkspaceVoice }) {
  const t = useTranslations('workspace.voice');
  const tRoot = useTranslations('workspace');
  const format = useFormatter();

  const [draft, setDraft] = useState(voice.guidance ?? '');
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [sample, setSample] = useState<string | null>(null);
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'unavailable'>('idle');

  const trimmed = draft.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < VOICE_MIN;
  const isRevert = trimmed.length === 0;

  /*
   * The sample follows the draft, debounced.
   *
   * Regenerating on every keystroke would spend a model call per character and
   * show a reply written from half a sentence. A pause is the signal that the
   * guidance is worth previewing.
   */
  useEffect(() => {
    // Below the minimum there is nothing to preview, and the panel derives
    // that at render rather than being told it here - state written
    // synchronously inside an effect is state that can disagree with the
    // props it was computed from.
    if (trimmed.length < VOICE_MIN) return undefined;

    const id = setTimeout(async () => {
      setSampleState('loading');
      const result = await previewVoiceSample(trimmed);
      if (result.ok) {
        setSample(result.reply);
        setSampleState('idle');
        return;
      }
      setSample(null);
      // Unavailable is expected whenever the AI service is down, and is not
      // the same as the guidance being wrong. Its own wording says so.
      setSampleState(result.reason === 'unavailable' ? 'unavailable' : 'idle');
    }, 700);

    return () => clearTimeout(id);
  }, [trimmed]);

  function save() {
    setStatus(null);
    setIsError(false);
    startTransition(async () => {
      const result = await saveWorkspaceVoice(trimmed);
      if (result.ok) {
        // A cleared voice is handed back to the learner, not thrown away, and
        // the two are indistinguishable from an empty box unless we say which.
        setStatus(result.data.reverted ? t('reverted') : tRoot('saved'));
        return;
      }
      setIsError(true);
      setStatus(result.reason === 'stale' ? tRoot('stale') : tRoot('failed'));
    });
  }

  /*
   * What the panel shows, derived rather than stored. A draft that has fallen
   * back below the minimum must not keep displaying the sample written from
   * the longer one - that sample is no longer what this guidance would do.
   */
  const isPreviewable = trimmed.length >= VOICE_MIN;
  const shownSample = isPreviewable && sampleState === 'idle' ? sample : null;
  const panelMessage = !isPreviewable
    ? t('sampleEmpty')
    : sampleState === 'loading'
      ? t('generating')
      : sampleState === 'unavailable'
        ? t('sampleUnavailable')
        : t('sampleEmpty');

  const sourceLine =
    voice.source === 'edited' && voice.editedAt
      ? t('sourceEdited', { date: format.dateTime(new Date(voice.editedAt), 'short') })
      : voice.source === 'learned'
        ? t('sourceLearned')
        : t('sourceNone');

  const sampleBox = (
    <div>
      <div
        className={[styles.sample, shownSample ? '' : styles.sampleUnavailable].join(' ').trim()}
        data-testid="voice-sample"
      >
        {shownSample ?? panelMessage}
      </div>
      <p className={styles.sampleCaption}>{t('sampleTitle')}</p>
    </div>
  );

  /*
    11 draws a READ state - the setting, the sample, its caption - and edits
    in place (11e). The voice is stored as words, so the words are what the
    read state shows where 02 has tone chips.
  */
  if (!editing) {
    return (
      <section className={styles.card} data-card="voice" data-testid="voice-card">
        <p className={styles.cardTitle}>{t('title')}</p>
        <p
          className={[styles.voiceText, trimmed ? '' : styles.voiceUnset].join(' ').trim()}
          data-testid="voice-text"
        >
          {trimmed || t('sourceNone')}
        </p>
        {/* With no voice the line above already says so: said once. */}
        {trimmed || status ? (
          <p className={styles.status} data-testid="voice-status">
            {status ?? sourceLine}
          </p>
        ) : null}
        {sampleBox}
        <button
          type="button"
          className={styles.cardLink}
          data-testid="voice-edit"
          onClick={() => setEditing(true)}
        >
          {t('edit')}
        </button>
      </section>
    );
  }

  return (
    <section className={styles.card} data-card="voice" data-testid="voice-card">
      <p className={styles.cardTitle}>{t('title')}</p>

      <textarea
        className={styles.voiceField}
        data-testid="voice-field"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('placeholder')}
        maxLength={VOICE_MAX}
        aria-label={t('title')}
        aria-describedby="voice-help"
      />
      <p id="voice-help" className={styles.sampleCaption}>
        {t('help')}
      </p>

      <div className={styles.voiceFooter}>
        <Button
          variant="primary"
          size="sm"
          data-testid="voice-save"
          onClick={save}
          // Short-but-not-empty is the only invalid state: empty is a
          // deliberate revert, and the server treats it as one.
          disabled={isPending || tooShort}
        >
          {isPending ? tRoot('saving') : isRevert ? t('revert') : tRoot('save')}
        </Button>
        <button
          type="button"
          className={styles.cardLink}
          data-testid="voice-done"
          onClick={() => setEditing(false)}
        >
          {t('done')}
        </button>
        <span
          className={[styles.status, isError ? styles.statusError : ''].join(' ').trim()}
          data-testid="voice-status"
        >
          {status ?? sourceLine}
        </span>
        <span
          className={[styles.counter, tooShort ? styles.counterShort : ''].join(' ').trim()}
          data-testid="voice-counter"
        >
          {tooShort
            ? t('tooShort', { count: trimmed.length, min: VOICE_MIN })
            : t('counter', { count: trimmed.length, max: VOICE_MAX })}
        </span>
      </div>

      {sampleBox}
    </section>
  );
}
