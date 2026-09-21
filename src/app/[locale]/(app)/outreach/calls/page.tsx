import { getTranslations } from 'next-intl/server';

import { CallLog } from '@/features/calls/CallLog';
import styles from '@/features/calls/Calls.module.css';
import { loadCalls } from '@/features/calls/load-calls';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Outreach · calls — screen 05d.
 *
 * ── THREE STATES, AND THE FIRST IS NOT A FAILURE ──
 * `voiceCopilotGate` answers **404 for the whole voice router** when
 * `tenant.voiceCopilotEnabled` is false — identical to the 404 a missing route
 * gives. So the screen reads `tenant-settings`, which is outside the gate,
 * and can then say *"voice is not switched on here"* as a fact rather than
 * guessing at an error. **The ambiguity is resolved by asking a different
 * question, not by reading the 404 more carefully.**
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No "Or have GOTCHA call a list".** There is no AI calling campaign: no
 * model, no list-driven object, no per-call outcome capture tied to one.
 *
 * **No "Ended in a sale".** `converted` is a concept nowhere in this platform
 * and this is its **fourth appearance across four screens**.
 *
 * **No "Upset" badge.** Sentiment exists on 9 of 89 conversations here and is
 * 48+ days old where it exists.
 *
 * The transcript IS offered: a call is a conversation and its transcript is
 * `Message` rows on the VOICE channel, written one per final utterance with
 * the speaker on each.
 */
export default async function Page() {
  const t = await getTranslations('calls');
  const { voiceEnabled, calls, summary, failed } = await loadCalls();

  if (!voiceEnabled) {
    // A fact about the workspace, not a fault. It reads as an explanation and
    // names what would change it.
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <div className={styles.off} data-testid="calls-not-enabled">
          <p className={styles.offLead}>{t('notEnabled')}</p>
          <p className={styles.offBody}>{t('notEnabledBody')}</p>
        </div>
      </PageContainer>
    );
  }

  if (failed || calls === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="calls-unavailable">{t('unavailable')}</p>
      </PageContainer>
    );
  }

  if (calls.length === 0) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <div className={styles.empty} data-testid="calls-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t('title')} description={t('description')}>
      <CallLog calls={calls} summary={summary} />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
