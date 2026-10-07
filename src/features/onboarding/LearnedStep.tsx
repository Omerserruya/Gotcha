'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { Discovery, ScannedFact } from '@/api/contracts/onboarding';
import { VOICE_MAX, VOICE_MIN, type WorkspaceVoice } from '@/api/contracts/workspace';
import { previewVoiceSample, saveWorkspaceVoice } from '@/features/workspace/actions';
import { UnavailableItem } from '@/design-system/primitives/unavailable/Unavailable';
import { Link } from '@/i18n/navigation';
import { plainDashes } from '@/lib/plain-dashes';

import styles from './Onboarding.module.css';

const SHOWN = 8;
/** A brand word longer than this is a sentence, not a chip. */
const CHIP_MAX = 32;

/**
 * 00f - What it learned (design 6).
 *
 * Left: what the read put in Knowledge, each with its page. A website read
 * goes into Knowledge as it is - there is no approve step on the backend -
 * so the screen says it is already there, and where to change it.
 * Right: how you sound - the words the read heard (`discovery.brand`) and
 * the voice GOTCHA writes in, which IS one guidance text (`/workspace/voice`).
 *
 * ★ Drawn with their reason: pages that disagree (no conflict check for a
 *   website), and Formal ↔ Casual (the voice stores no scale).
 * ★ The sample reply is asked for, never generated on arrival: it is a model
 *   call, and it is the draft's - "what would this sound like".
 */
export function LearnedStep({
  discovery,
  facts,
  voice,
}: {
  readonly discovery: Discovery | null;
  readonly facts: readonly ScannedFact[] | null;
  readonly voice: WorkspaceVoice | null;
}) {
  const t = useTranslations('onboarding.learned');
  const pages = discovery?.crawl?.pagesRead ?? null;
  return (
    <div className={styles.learned}>
      <div className={styles.learnedMain}>
        <h1 className={styles.title}>{t('title')}</h1>
        <p className={styles.subtitle} data-testid="learned-count">
          {facts === null
            ? t('unread')
            : facts.length === 0
              ? t('none')
              : pages
                ? t('countFromPages', { facts: facts.length, pages })
                : t('count', { facts: facts.length })}
        </p>
        {facts && facts.length > 0 ? (
          <ul className={styles.facts} data-testid="learned-facts">
            {facts.slice(0, SHOWN).map((fact) => (
              <li key={fact.id} className={styles.fact}>
                <span className={styles.factText}>
                  <bdi dir="auto">{fact.title}</bdi>
                </span>
                {fact.path ? (
                  <bdi dir="ltr" className={styles.factPath}>
                    {fact.path}
                  </bdi>
                ) : null}
                {fact.ready ? (
                  <Check size={14} className={styles.factReady} aria-label={t('inKnowledge')} />
                ) : (
                  <span className={styles.quiet}>{t('learning')}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {facts && facts.length > 0 ? (
          <p className={styles.quiet}>
            {t.rich('whereToChange', {
              knowledge: (chunks) => (
                <Link href="/studio/knowledge" className={styles.inlineLink}>
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : facts !== null ? (
          <span className={styles.actions}>
            <Link href="/onboarding/website" className={styles.secondary}>
              {t('readAgain')}
            </Link>
          </span>
        ) : null}
        <p className={styles.notYet} data-testid="learned-conflicts">
          {t('conflictsWhy')}
        </p>
      </div>
      <Voice voice={voice} brand={discovery?.brand ?? null} />
    </div>
  );
}

function Voice({
  voice,
  brand,
}: {
  readonly voice: WorkspaceVoice | null;
  readonly brand: Discovery['brand'];
}) {
  const t = useTranslations('onboarding.learned.voice');
  const tn = useTranslations('onboarding');
  // A learned voice is the model's writing: plain hyphens. An edited one is the person's.
  const raw = voice?.guidance?.trim() || '';
  const stored = voice?.source === 'learned' ? plainDashes(raw) : raw;
  const [guidance, setGuidance] = useState(stored);
  const [editing, setEditing] = useState(stored === '');
  const [draft, setDraft] = useState(stored);
  const [saved, setSaved] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [sample, setSample] = useState<
    { readonly reply: string } | 'unavailable' | 'failed' | null
  >(null);
  const [isSaving, startSave] = useTransition();
  const [isAsking, startAsk] = useTransition();

  const traits = [brand?.voice, brand?.tone, brand?.style]
    .map((w) => w?.trim() ?? '')
    .filter((w) => w !== '' && w.length <= CHIP_MAX);
  const says = (brand?.vocabulary ?? []).slice(0, 3);
  const never = (brand?.forbiddenWords ?? []).slice(0, 3);
  const text = editing ? draft.trim() : guidance;
  const long = text.length >= VOICE_MIN;

  const save = () =>
    startSave(async () => {
      const result = await saveWorkspaceVoice(draft.trim());
      if (result.ok) {
        setGuidance(result.data.guidance?.trim() ?? draft.trim());
        setEditing(false);
        setSaved('saved');
      } else setSaved('failed');
    });

  const ask = () =>
    startAsk(async () => {
      const result = await previewVoiceSample(text);
      setSample(result.ok ? { reply: result.reply } : result.reason);
    });

  return (
    <section className={styles.voice} aria-labelledby="voice-title" data-testid="learned-voice">
      <h2 className={styles.voiceTitle} id="voice-title">
        {t('title')}
      </h2>
      {voice === null ? <p className={styles.quiet}>{t('unread')}</p> : null}
      {traits.length > 0 ? (
        <span className={styles.traits} data-testid="voice-traits">
          {traits.map((trait) => (
            <span key={trait} className={styles.trait}>
              <bdi dir="auto">{trait}</bdi>
            </span>
          ))}
        </span>
      ) : null}
      {/* The voice stores no scale: a status, not a slider to drag. */}
      <UnavailableItem
        title={`${t('formal')} ↔ ${t('casual')}`}
        tag={tn('notYet')}
        why={t('scaleWhy')}
        testid="voice-scale"
      />
      {says.length > 0 || never.length > 0 ? (
        <span className={styles.saysNever}>
          {says.length > 0 ? (
            <span>
              <span className={styles.eyebrow}>{t('says')}</span>
              {says.map((w) => (
                <span key={w} className={styles.said}>
                  <bdi dir="auto">“{w}”</bdi>
                </span>
              ))}
            </span>
          ) : null}
          {never.length > 0 ? (
            <span>
              <span className={styles.eyebrow}>{t('never')}</span>
              {never.map((w) => (
                <span key={w} className={styles.said}>
                  <bdi dir="auto">“{w}”</bdi>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}

      {editing ? (
        <span className={styles.voiceEdit}>
          <span className={styles.eyebrow}>{t('guidance')}</span>
          <textarea
            className={styles.voiceText}
            value={draft}
            maxLength={VOICE_MAX}
            rows={4}
            dir="auto"
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved('idle');
            }}
            placeholder={t('placeholder')}
            aria-label={t('guidance')}
            data-testid="voice-guidance"
          />
          <span className={styles.quiet}>
            {draft.trim().length < VOICE_MIN ? t('tooShort', { min: VOICE_MIN }) : ' '}
          </span>
        </span>
      ) : (
        <p className={styles.guidance} data-testid="voice-stored">
          <bdi dir="auto">{guidance}</bdi>
        </p>
      )}

      <span className={styles.eyebrow}>{t('reply')}</span>
      {sample && typeof sample === 'object' ? (
        <p className={styles.sample} data-testid="voice-sample">
          <bdi dir="auto">{sample.reply}</bdi>
        </p>
      ) : (
        <p className={styles.quiet} data-testid="voice-sample-none">
          {sample === 'unavailable'
            ? t('sampleUnavailable')
            : sample === 'failed'
              ? t('sampleFailed')
              : long
                ? t('sampleAsk')
                : t('sampleNeedsVoice')}
        </p>
      )}
      <button
        type="button"
        className={styles.textButton}
        onClick={ask}
        disabled={!long || isAsking}
        data-testid="voice-ask"
      >
        {isAsking ? t('asking') : t('ask')}
      </button>

      {saved === 'failed' ? (
        <p className={styles.problem} role="alert">
          {t('saveFailed')}
        </p>
      ) : saved === 'saved' ? (
        <p className={styles.quiet} role="status">
          {t('saved')}
        </p>
      ) : null}
      <span className={styles.actions}>
        {editing ? (
          <>
            <button
              type="button"
              className={styles.primary}
              onClick={save}
              disabled={isSaving || draft.trim().length < VOICE_MIN}
              data-testid="voice-save"
            >
              {isSaving ? t('saving') : t('save')}
            </button>
            {guidance ? (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  setDraft(guidance);
                  setEditing(false);
                }}
              >
                {t('cancel')}
              </button>
            ) : (
              <Link href="/onboarding/truth" className={styles.secondary} data-testid="voice-skip">
                {t('later')}
              </Link>
            )}
          </>
        ) : (
          <>
            <Link href="/onboarding/truth" className={styles.primary} data-testid="voice-yes">
              {t('soundsLikeUs')}
            </Link>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setDraft(guidance);
                setEditing(true);
                setSample(null);
              }}
              data-testid="voice-adjust"
            >
              {t('adjust')}
            </button>
          </>
        )}
      </span>
    </section>
  );
}
