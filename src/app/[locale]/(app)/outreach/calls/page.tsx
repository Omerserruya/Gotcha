import { getTranslations } from 'next-intl/server';

import { CallLog } from '@/features/calls/CallLog';
import styles from '@/features/calls/Calls.module.css';
import { loadCalls, loadLiveCall } from '@/features/calls/load-calls';
import { LiveCall } from '@/features/calls/LiveCall';
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
  const { voiceEnabled, hasNumber, calls, summary, failed } = await loadCalls();
  // 05e lives on the same route: a call in progress is the thing you need
  // when there is one, and the log is what you need when there is not.
  const { call: liveCall, transcript } =
    voiceEnabled === true ? await loadLiveCall() : { call: null, transcript: [] };

  /*
   * ★ WE COULD NOT FIND OUT, WHICH IS NOT "YOU DO NOT HAVE IT".
   *
   * The settings read is what resolves the gate's ambiguous 404. When IT
   * fails there is no answer, and rendering the not-enabled panel would tell
   * a merchant to go and ask for a feature that may already be on — which is
   * what it would have done from the moment voice was switched on.
   */
  if (voiceEnabled === null) {
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <p data-testid="calls-availability-unknown">{t('availabilityUnknown')}</p>
      </PageContainer>
    );
  }

  if (voiceEnabled === false) {
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

  if (calls.length === 0 && !liveCall) {
    /*
     * ★ TWO EMPTY SCREENS, BECAUSE THERE ARE TWO REASONS TO BE EMPTY.
     *
     * "Calls appear here as they happen" is a promise, and it is only true
     * for a workspace that can receive one. `hasActiveVoiceChannel` is the
     * platform's own precondition — no ACTIVE VOICE channel means no call
     * can arrive, so the honest sentence names the missing number instead of
     * describing a future that cannot happen.
     *
     * `hasNumber === null` cannot reach here: it travels with
     * `voiceEnabled === null`, which returned above.
     */
    const noNumber = hasNumber === false;
    return (
      <PageContainer title={t('title')} description={t('description')}>
        <div className={styles.empty} data-testid={noNumber ? 'calls-no-number' : 'calls-empty'}>
          <p className={styles.emptyLead}>{noNumber ? t('noNumber') : t('none')}</p>
          <p className={styles.emptyBody}>{noNumber ? t('noNumberBody') : t('noneBody')}</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t('title')} description={t('description')}>
      {liveCall ? (
        <LiveCall
          conversationId={liveCall.conversationId}
          customerNumber={liveCall.customerNumber}
          initialTranscript={transcript}
        />
      ) : null}
      <CallLog calls={calls} summary={summary} />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
