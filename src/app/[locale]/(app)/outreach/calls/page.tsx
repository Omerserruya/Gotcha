import { getTranslations } from 'next-intl/server';

import {
  CallStats,
  DialerCard,
  parseCallFilter,
  RecentCalls,
  type CallsState,
} from '@/features/calls/CallsScreen';
import styles from '@/features/calls/Calls.module.css';
import { loadCalls, loadLiveCall } from '@/features/calls/load-calls';
import { LiveCall } from '@/features/calls/LiveCall';
import { loadCustomers } from '@/features/customers/load-customers';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Screen 05d — phone calls.
 *
 * One frame in every state: the dialer, the week's figures, and the recent
 * calls card, whose body says why it is empty when it is — voice off, no
 * number, a failed read — rather than the whole screen collapsing to a
 * sentence. `?q=` searches, `?calls=` filters.
 *
 * 05e lives on the same route: a call in progress heads the column, because
 * it is the thing you need when there is one.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly q?: string; readonly calls?: string }>;
}) {
  const t = await getTranslations('calls');
  const params = (await searchParams) ?? {};
  const query = (params.q ?? '').trim();
  const filter = parseCallFilter(params.calls);

  const [{ voiceEnabled, hasNumber, calls, summary, failed }, search] = await Promise.all([
    // "This week": the last seven days, so Monday morning is not an empty week.
    loadCalls({ summaryDays: 7 }),
    query ? loadCustomers(query) : Promise.resolve(null),
  ]);
  const {
    call: liveCall,
    transcript,
    contactName,
  } = voiceEnabled === true
    ? await loadLiveCall()
    : { call: null, transcript: [], contactName: null };

  const state: CallsState =
    voiceEnabled === null
      ? 'unknown'
      : voiceEnabled === false
        ? 'off'
        : failed || calls === null
          ? 'failed'
          : calls.length === 0
            ? hasNumber === false
              ? 'noNumber'
              : 'none'
            : 'ok';

  /*
    05e: a call in progress IS the page — the transcript and Copilot, the
    call's own header across the top — rather than a strip above the log.
  */
  if (liveCall) {
    return (
      <PageContainer layout="screen" flush>
        <LiveCall
          sessionId={liveCall.id}
          conversationId={liveCall.conversationId}
          customerNumber={liveCall.customerNumber}
          customerId={liveCall.customerId}
          contactName={contactName}
          direction={liveCall.direction}
          startedAt={liveCall.answeredAt ?? liveCall.startedAt}
          initialTranscript={transcript}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer layout="screen" flush title={t('title')} description={t('description')}>
      <div className={styles.screen} data-testid="calls-screen">
        <DialerCard query={query} results={search === null ? (query ? null : []) : search.rows} />
        <div className={styles.column}>
          <CallStats week={voiceEnabled === true ? summary : null} />
          <RecentCalls calls={calls ?? []} state={state} filter={filter} />
        </div>
      </div>
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
