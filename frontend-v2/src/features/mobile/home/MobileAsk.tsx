'use client';

import { ArrowUp, BadgeCheck, Sparkles, Square } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { ThreadStep } from '@/api/contracts/assistant-threads';
import { AnswerBlocks, SourceChips } from '@/features/home/AnswerBlocks';
import { AnswerText } from '@/features/home/AnswerText';
import type { ThreadTurn, TurnProblem } from '@/features/home/thread-turns';
import {
  AnswerWordsProvider,
  TurnWords,
  useTurnLang,
  useTurnTranslations,
  type AnswerWords,
} from '@/features/home/turn-words';
import { useAssistantThread } from '@/features/home/use-assistant-thread';
import { Link } from '@/i18n/navigation';
import { appPath } from '@/lib/base-path';
import { typedDir } from '@/lib/typed-dir';
import { usePurchaseLinksAllowed } from '@/shell/mobile/web-only';

import ui from '../mobile-ui.module.css';
import styles from './mobile-ask.module.css';
import { approvalHref, canAsk, dockMode } from './mobile-ask';

/**
 * "Ask GOTCHA" on the phone (Omer, 2026-11-03): the design's ask bar on Home
 * opens this, a full screen of one conversation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE WEBSITE'S THREAD, NOT A SECOND ONE
 * ════════════════════════════════════════════════════════════════════════════
 * `useAssistantThread`, the desktop Home's own hook: the thread is created on
 * the first question (`POST /api/assistant/threads`), the answer streams
 * through the BFF and is picked up again after a drop, Stop is the route's
 * cancel, and the thread's address is `?thread=` - so a thread started here
 * is in Recent on the website, and one opened from there reads the same here.
 * The answer is drawn by the website's own renderers (`AnswerText`,
 * `AnswerBlocks`, `SourceChips`) in the turn's language (`TurnWords`).
 *
 * ★ A plan an answer proposes is decided in the phone's Approvals, one tap
 *   away - never here: deciding sits on the request's own screen.
 * ★ Every refusal is said as itself (busy, too many questions, no credits,
 *   the AI not answering), never as a silent empty answer.
 */
export function MobileAsk({ answerWords }: { readonly answerWords: AnswerWords }) {
  const chat = useAssistantThread();
  const asked = useSearchParams()?.get('thread') ?? null;
  const shown = chat.thread?.id ?? null;

  // The address leads: `?thread=` opens that thread; none is a new one, asked below.
  useEffect(() => {
    if (asked && asked !== shown) void chat.open(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address is the only trigger
  }, [asked]);

  return (
    <AnswerWordsProvider words={answerWords}>
      <Conversation chat={chat} />
    </AnswerWordsProvider>
  );
}

type Chat = ReturnType<typeof useAssistantThread>;

function Conversation({ chat }: { readonly chat: Chat }) {
  const t = useTranslations('home.conversation');
  const m = useTranslations('mobile.home.askScreen');
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const last = chat.turns.at(-1);
  const mode = dockMode(last);

  // The newest words in view as they arrive.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last?.answer, last?.steps.length, chat.turns.length]);

  const send = (question: string) => {
    if (!canAsk(question, last, chat.opening)) return;
    setDraft('');
    void chat.ask(question.trim());
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'stop' && last) void chat.cancel(last.id);
    else send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };
  const suggestions = last && last.status === 'done' ? last.suggestions : [];

  return (
    <section className={styles.chat} aria-label={t('label')} data-testid="mobile-ask">
      <div className={styles.stream}>
        {chat.opening === 'opening' ? (
          <p className={styles.note} role="status" data-testid="mobile-ask-opening">
            {t('opening')}
          </p>
        ) : chat.opening === 'missing' || chat.opening === 'failed' ? (
          <p className={styles.problem} role="alert" data-testid="mobile-ask-unopened">
            {chat.opening === 'missing' ? t('missing') : t('openFailed')}
          </p>
        ) : chat.turns.length === 0 ? (
          <div className={ui.empty} data-testid="mobile-ask-empty">
            <span className={styles.emptyMark} aria-hidden="true">
              <Sparkles size={22} strokeWidth={2} />
            </span>
            <span className={ui.emptyTitle}>{m('title')}</span>
            <span>{m('hint')}</span>
          </div>
        ) : (
          <>
            {chat.thread?.title ? (
              <h1 className={styles.title} dir="auto" data-testid="mobile-ask-title">
                {chat.thread.title}
              </h1>
            ) : null}
            <ol className={styles.turns}>
              {chat.turns.map((turn) => (
                <li
                  key={turn.id}
                  className={styles.turn}
                  data-testid={`mobile-turn-${turn.id}`}
                  data-status={turn.status}
                >
                  <p className={styles.question} dir="auto">
                    {turn.question}
                  </p>
                  <TurnWords lang={turn.lang}>
                    <Answer turn={turn} threadId={chat.thread?.id ?? null} />
                  </TurnWords>
                </li>
              ))}
            </ol>
          </>
        )}
        <div ref={end} />
      </div>

      {suggestions.length > 0 ? (
        <div
          className={ui.chips}
          role="group"
          aria-label={t('suggestions')}
          data-testid="mobile-ask-suggestions"
        >
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className={ui.chip}
              dir="auto"
              onClick={() => send(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <form className={styles.dock} onSubmit={onSubmit} data-testid="mobile-ask-dock">
        <textarea
          className={styles.input}
          value={draft}
          rows={1}
          dir={typedDir(draft)}
          placeholder={m('placeholder')}
          aria-label={m('placeholder')}
          // The screen is opened to ask: the field is ready, the keyboard up.
          autoFocus
          enterKeyHint="send"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="mobile-ask-input"
        />
        {mode === 'send' ? (
          <button
            type="submit"
            className={styles.go}
            aria-label={t('send')}
            disabled={!canAsk(draft, last, chat.opening)}
            data-testid="mobile-ask-send"
          >
            <ArrowUp size={19} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            className={styles.go}
            aria-label={mode === 'stopping' ? t('stopping') : t('stop')}
            disabled={mode === 'stopping'}
            data-testid="mobile-ask-stop"
          >
            <Square size={15} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
          </button>
        )}
      </form>
    </section>
  );
}

function Answer({
  turn,
  threadId,
}: {
  readonly turn: ThreadTurn;
  readonly threadId: string | null;
}) {
  const t = useTurnTranslations('home.conversation');
  const m = useTranslations('mobile.home.askScreen');
  return (
    <div className={styles.answer} lang={useTurnLang()}>
      {turn.steps.length > 0 ? (
        <ol className={styles.steps} data-testid="mobile-turn-steps">
          {turn.steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </ol>
      ) : turn.status === 'running' && !turn.answer ? (
        <p className={styles.note} role="status">
          {t('working')}
        </p>
      ) : null}
      {turn.answer ? (
        <div className={styles.text} aria-live="polite" data-testid="mobile-turn-answer">
          <AnswerText text={turn.answer} sources={turn.sources} />
        </div>
      ) : null}
      <AnswerBlocks
        blocks={turn.blocks}
        threadId={threadId}
        messageId={turn.messageId}
        sources={turn.sources}
      />
      <SourceChips sources={turn.sources} />
      {turn.proposals.map((proposal) => (
        <Link
          key={proposal.approvalRequestId}
          href={approvalHref(proposal.approvalRequestId) as '/m/approvals'}
          className={styles.proposal}
          data-testid={`mobile-turn-proposal-${proposal.approvalRequestId}`}
        >
          <BadgeCheck size={18} strokeWidth={2} aria-hidden="true" />
          <span className={styles.proposalText}>
            <span className={styles.proposalTitle}>{m('proposal')}</span>
            {proposal.summary ? <bdi dir="auto">{proposal.summary}</bdi> : null}
          </span>
        </Link>
      ))}
      {turn.problem ? (
        <Problem problem={turn.problem} />
      ) : turn.status === 'failed' ? (
        <p className={styles.problem} role="alert" data-testid="mobile-turn-failed">
          {t('failed')}
        </p>
      ) : turn.status === 'cancelled' ? (
        <p className={styles.note} data-testid="mobile-turn-stopped">
          {t('stopped')}
        </p>
      ) : null}
    </div>
  );
}

/** Why there is no (whole) answer, in the website's words for each refusal. */
export function Problem({ problem }: { readonly problem: TurnProblem }) {
  const t = useTurnTranslations('home.conversation.problem');
  const locale = useLocale();
  /*
   * ★ No billing inside the app (App Store 3.1.1): the shell would open it in
   *   the browser - a purchase outside the app. There the sentence says what
   *   happened and points nowhere (`creditsApp`); the web keeps the link.
   */
  const mayLinkBilling = usePurchaseLinksAllowed();
  // Billing is the website's: a full load.
  const billing = (chunks: ReactNode) => (
    <a href={appPath(`/${locale}/settings/billing`)} className={styles.link}>
      {chunks}
    </a>
  );
  return (
    <p
      className={styles.problem}
      role="alert"
      data-testid="mobile-turn-failed"
      data-problem={problem.kind}
    >
      {problem.kind === 'rate'
        ? problem.retryAfterSeconds
          ? t('rate', { seconds: problem.retryAfterSeconds })
          : t('rateSoon')
        : problem.kind === 'credits'
          ? mayLinkBilling
            ? t.rich('credits', { billing })
            : t('creditsApp')
          : t(problem.kind)}
    </p>
  );
}

/** One step of the work, in the run's words: done, running, waiting on a person, or failed. */
function Step({ step }: { readonly step: ThreadStep }) {
  const t = useTurnTranslations('home.conversation.step');
  return (
    <li className={styles.step} data-status={step.status}>
      <span className={styles.stepMark} aria-hidden="true">
        {step.status === 'running' ? (
          <span className={styles.spinner} />
        ) : step.status === 'done' ? (
          '✓'
        ) : step.status === 'waiting_approval' ? (
          '•'
        ) : (
          '×'
        )}
      </span>
      <span className={styles.stepText} dir="auto">
        {step.text}
      </span>
      <span className={styles.stepState}>{t(step.status)}</span>
      {step.status === 'waiting_approval' ? (
        <Link href={approvalHref(step.approvalRequestId) as '/m/approvals'} className={styles.link}>
          {t('openApprovals')}
        </Link>
      ) : null}
    </li>
  );
}
