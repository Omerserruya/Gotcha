'use client';

import { ArrowLeft, ArrowUp, ChevronDown, Pencil, Square, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { SCOPE_RANGES, type ThreadScope, type ThreadStep } from '@/api/contracts/assistant-threads';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { Link } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import { AnswerBlocks, SourceChips } from './AnswerBlocks';
import { ProposalCard } from './ProposalCard';
import { AnswerText } from './AnswerText';
import { AskContext } from './home-ask';
import styles from './HomeConversation.module.css';
import type { ThreadTurn, TurnProblem } from './thread-turns';
import {
  AnswerWordsProvider,
  TurnWords,
  useTurnLang,
  useTurnTranslations,
  type AnswerWords,
} from './turn-words';
import { useAssistantThread } from './use-assistant-thread';

/** A title the route keeps: 1-120 characters (§2). */
const TITLE_MAX = 120;

/**
 * ★★ Home · in conversation (design 7, 01a; Omer, 2026-10-07), on
 * `/api/assistant/threads` (Backend aef95f69 + 6a4fd095).
 *
 * Sending the first message transforms Home IN PLACE: the greeting and the
 * snapshot leave, the command box docks at the bottom - no modal, no new
 * page. The thread is saved: its address is `?thread=`, Recent in the rail
 * reopens it, and a reload mid-answer comes back to the same answer.
 *
 * Drawn: the steps in the run's own words with the time each took, the
 * answer in its markdown subset, follow-up suggestions, Stop (the route's
 * cancel), the title (the server's, until the person renames it), the
 * scope, and Delete. Share is a status ("next stage"); blocks, sources and
 * actions are stages 2-3.
 */
export function HomeConversation({
  children,
  answerWords = {},
}: {
  readonly children: ReactNode;
  /** `home.conversation` in each language - a turn's own words (turn-words.tsx). */
  readonly answerWords?: AnswerWords;
}) {
  const chat = useAssistantThread();
  const asked = useSearchParams()?.get('thread') ?? null;
  const shown = chat.thread?.id ?? null;

  /*
    The address leads: a Recent link opens its thread; Home's own link (no
    `?thread=`) is the live Home again. The hook writes the address itself
    when it creates a thread, and then the two already agree.
  */
  useEffect(() => {
    if (asked && asked !== shown) void chat.open(asked);
    else if (!asked && shown) chat.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address is the only trigger
  }, [asked]);

  const inConversation = chat.turns.length > 0 || chat.opening !== 'idle' || shown !== null;
  return (
    <AnswerWordsProvider words={answerWords}>
      <AskContext.Provider value={(question) => void chat.ask(question)}>
        {inConversation ? <Conversation chat={chat} /> : children}
      </AskContext.Provider>
    </AnswerWordsProvider>
  );
}

type Chat = ReturnType<typeof useAssistantThread>;

function Conversation({ chat }: { readonly chat: Chat }) {
  const t = useTranslations('home.conversation');
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** 03's Ask: a thread about one approval request (ai 9a86bfac). */
  const about = chat.thread?.context?.approvalId ?? null;
  const last = chat.turns.at(-1);
  const running = last?.status === 'running';

  /*
    Opened from a request's Ask: the box waits for the question, focused -
    nothing is sent on anyone's behalf.
  */
  const fresh = about !== null && chat.opening === 'idle' && chat.turns.length === 0;
  useEffect(() => {
    if (fresh) input.current?.focus();
  }, [fresh]);

  // The newest words in view as they arrive.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last?.answer, last?.steps.length, chat.turns.length]);

  const send = (question: string) => {
    const text = question.trim();
    if (!text || running || chat.opening !== 'idle') return;
    setDraft('');
    void chat.ask(text);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };
  // The last answer's follow-ups, once it is finished.
  const suggestions = last && last.status === 'done' ? last.suggestions : [];

  return (
    <section className={styles.chat} aria-label={t('label')} data-testid="home-conversation">
      <header className={styles.bar}>
        <button
          type="button"
          className={styles.back}
          onClick={chat.reset}
          data-testid="conversation-home"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('home')}
        </button>
        <span className={styles.rule} aria-hidden="true" />
        <Title chat={chat} />
        {chat.opening === 'idle' ? <ScopeChip chat={chat} /> : null}
        <span className={styles.barEnd}>
          {chat.thread ? <DeleteThread onDelete={chat.remove} /> : null}
          <UnavailableAction
            label={t('share')}
            tag={t('nextStage')}
            why={t('shareWhy')}
            testid="conversation-share"
          />
        </span>
      </header>

      <div className={styles.scroll}>
        {chat.opening === 'opening' ? (
          <p className={styles.working} role="status" data-testid="conversation-opening">
            {t('opening')}
          </p>
        ) : chat.opening === 'missing' || chat.opening === 'failed' ? (
          <p className={styles.problem} role="alert" data-testid="conversation-unopened">
            {t(chat.opening === 'missing' ? 'missing' : 'openFailed')}
          </p>
        ) : (
          <>
            {about ? (
              <p className={styles.about} data-testid="conversation-about">
                {t('about.line')}{' '}
                <Link
                  href={{ pathname: '/approvals', query: { id: about } }}
                  className={styles.aboutLink}
                  data-testid="conversation-about-open"
                >
                  {t('about.open')}
                </Link>
              </p>
            ) : null}
            <ol className={styles.turns}>
              {chat.turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} threadId={chat.thread?.id ?? null} />
              ))}
            </ol>
          </>
        )}
        <div ref={end} />
      </div>

      {/* 01a's box: what to say next, then the follow-ups beside the arrow. */}
      <form className={styles.dock} onSubmit={onSubmit} data-testid="conversation-dock">
        <label className="srOnly" htmlFor="conversation-input">
          {t('placeholder')}
        </label>
        <textarea
          ref={input}
          id="conversation-input"
          className={styles.input}
          value={draft}
          rows={1}
          dir={typedDir(draft)}
          maxLength={4000}
          placeholder={t('placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="conversation-input"
        />
        <span className={styles.dockRow}>
          {suggestions.length > 0 ? (
            <ul
              className={styles.suggestions}
              aria-label={t('suggestions')}
              data-testid="suggestions"
            >
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    className={styles.suggestion}
                    onClick={() => send(suggestion)}
                  >
                    <bdi dir="auto">{suggestion}</bdi>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {running && last ? (
            <button
              type="button"
              className={styles.send}
              onClick={() => void chat.cancel(last.id)}
              disabled={last.cancelling}
              aria-label={last.cancelling ? t('stopping') : t('stop')}
              data-testid="conversation-stop"
            >
              <Square size={11} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              type="submit"
              className={styles.send}
              disabled={draft.trim() === '' || chat.opening !== 'idle'}
              aria-label={t('send')}
              data-testid="conversation-send"
            >
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          )}
        </span>
      </form>
    </section>
  );
}

/**
 * The thread's title: the server's after the first answer, the first
 * question until then - and the person's own once they rename it, which
 * the server never writes over.
 */
function Title({ chat }: { readonly chat: Chat }) {
  const t = useTranslations('home.conversation.title');
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const tc = useTranslations('home.conversation');
  // Untitled until its first answer: a thread about a request says so meanwhile.
  const shown =
    chat.thread?.title ??
    chat.turns[0]?.question ??
    (chat.thread?.context ? tc('about.title') : '');

  if (editing !== null) {
    const save = async () => {
      const title = editing.trim();
      if (!title || title === chat.thread?.title) {
        setEditing(null);
        return;
      }
      const ok = await chat.rename(title);
      setFailed(!ok);
      if (ok) setEditing(null);
    };
    return (
      <span className={styles.titleEdit}>
        <input
          className={styles.titleInput}
          value={editing}
          maxLength={TITLE_MAX}
          dir="auto"
          aria-label={t('label')}
          aria-invalid={failed || undefined}
          // The person just asked to edit it.
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Escape') {
              setFailed(false);
              setEditing(null);
            }
          }}
          onBlur={() => void save()}
          data-testid="conversation-title-input"
        />
        {failed ? (
          <span
            className={styles.titleProblem}
            role="alert"
            data-testid="conversation-title-failed"
          >
            {t('failed')}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className={styles.titleRow}>
      {/* The heading itself takes the title's direction: a Hebrew title's "?" at its end. */}
      <h1 className={styles.title} data-testid="conversation-title" dir="auto">
        {shown}
      </h1>
      {chat.thread ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('rename')}
          onClick={() => {
            setFailed(false);
            setEditing(shown);
          }}
          data-testid="conversation-rename"
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * What the answers look at: the range (and, read only, the channels). A
 * change applies to the questions after it; each answer was given under its
 * own scope (§1).
 */
function ScopeChip({ chat }: { readonly chat: Chat }) {
  const t = useTranslations('home.conversation.scope');
  const format = useFormatter();
  const [failed, setFailed] = useState(false);
  const range = chat.scope.range;
  // Date-only strings are UTC days (§8): read and written in UTC, so no day shifts.
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const rangeWords =
    typeof range === 'string'
      ? t(`range.${range}`)
      : t('range.custom', { from: day(range.custom.from), to: day(range.custom.to) });
  // The dates the answers use, from the server - never recomputed here.
  const dates = chat.thread?.scopeDates
    ? t('range.custom', {
        from: day(chat.thread.scopeDates.from),
        to: day(chat.thread.scopeDates.to),
      })
    : null;
  const channelWords =
    chat.scope.channels === 'all'
      ? t('channels.all')
      : t('channels.some', { count: chat.scope.channels.length });
  // A custom range already is its dates; a named one adds them once the server gives them.
  const shownScope = [rangeWords, typeof range === 'string' ? dates : null, channelWords]
    .filter(Boolean)
    .join(' · ');
  const choose = async (next: ThreadScope['range']) => {
    setFailed(!(await chat.setScope({ ...chat.scope, range: next })));
  };
  return (
    <span className={styles.scope}>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={styles.scopeChip}
            aria-label={t('label', { scope: shownScope })}
            data-testid="conversation-scope"
          >
            <span className={styles.scopeText}>{shownScope}</span>
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          {SCOPE_RANGES.map((option) => (
            <MenuItem
              key={option}
              onSelect={() => void choose(option)}
              aria-checked={range === option}
              role="menuitemradio"
              data-testid={`conversation-scope-${option}`}
            >
              {t(`range.${option}`)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {failed ? (
        <span className={styles.titleProblem} role="alert" data-testid="conversation-scope-failed">
          {t('failed')}
        </span>
      ) : null}
    </span>
  );
}

/** Delete, confirmed: the thread and every message in it, for good. */
function DeleteThread({ onDelete }: { readonly onDelete: () => Promise<boolean> }) {
  const t = useTranslations('home.conversation.delete');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'deleting' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t('button')}
        onClick={() => {
          setState('idle');
          setOpen(true);
        }}
        data-testid="conversation-delete"
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
      {open ? (
        <Dialog open onOpenChange={(next) => (next ? null : setOpen(false))}>
          <DialogContent
            title={t('title')}
            description={t('what')}
            data-testid="conversation-delete-dialog"
          >
            {state === 'failed' ? (
              <p className={styles.problem} role="alert" data-testid="conversation-delete-failed">
                {t('failed')}
              </p>
            ) : null}
            <span className={styles.dialogActions}>
              <button type="button" className={styles.quiet} onClick={() => setOpen(false)}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.danger}
                disabled={state === 'deleting'}
                onClick={async () => {
                  setState('deleting');
                  if (!(await onDelete())) setState('failed');
                }}
                data-testid="conversation-delete-yes"
              >
                {state === 'deleting' ? t('deleting') : t('yes')}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function TurnView({
  turn,
  threadId,
}: {
  readonly turn: ThreadTurn;
  /** Where its sources' full lists are read (stage 2). */
  readonly threadId: string | null;
}) {
  return (
    <li className={styles.turn} data-testid={`turn-${turn.id}`} data-status={turn.status}>
      {/* `dir="auto"` on the block itself: a Hebrew line is right to left, its "?" at its end. */}
      <p className={styles.question} dir="auto">
        {turn.question}
      </p>
      {/* The answer's own words in the turn's language (turn-words.tsx). */}
      <TurnWords lang={turn.lang}>
        <TurnAnswer turn={turn} threadId={threadId} />
      </TurnWords>
    </li>
  );
}

function TurnAnswer({
  turn,
  threadId,
}: {
  readonly turn: ThreadTurn;
  readonly threadId: string | null;
}) {
  const t = useTurnTranslations('home.conversation');
  return (
    <div className={styles.answerRow} lang={useTurnLang()} data-testid={`turn-${turn.id}-answer`}>
      <span className={styles.avatar} aria-hidden="true">
        <span />
      </span>
      <div className={styles.answerBody}>
        {turn.steps.length > 0 ? (
          <ol className={styles.steps} data-testid="turn-steps">
            {turn.steps.map((step) => (
              <StepLine key={step.id} step={step} />
            ))}
          </ol>
        ) : turn.status === 'running' && !turn.answer ? (
          <p className={styles.working} role="status">
            {t('working')}
          </p>
        ) : null}
        {turn.answer ? (
          <div aria-live="polite" data-testid="turn-answer">
            <AnswerText text={turn.answer} sources={turn.sources} />
          </div>
        ) : null}
        {/* 01a: the work under the words - the server's blocks, then what it stands on. */}
        <AnswerBlocks
          blocks={turn.blocks}
          threadId={threadId}
          messageId={turn.messageId}
          sources={turn.sources}
        />
        <SourceChips sources={turn.sources} />
        {/* Design 7 stage 3: what the answer proposes, decided here or in Approvals. */}
        {turn.proposals.map((proposal) => (
          <ProposalCard key={proposal.approvalRequestId} proposal={proposal} />
        ))}
        {turn.problem ? (
          <Problem problem={turn.problem} />
        ) : turn.status === 'failed' ? (
          <p className={styles.problem} role="alert" data-testid="turn-failed">
            {t('failed')}
          </p>
        ) : turn.status === 'cancelled' ? (
          <p className={styles.note} data-testid="turn-stopped">
            {t('stopped')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Why there is no (whole) answer, honestly: each refusal in its own words. */
function Problem({ problem }: { readonly problem: TurnProblem }) {
  const t = useTurnTranslations('home.conversation.problem');
  const billing = (chunks: ReactNode) => <Link href="/settings/billing">{chunks}</Link>;
  return (
    <p
      className={styles.problem}
      role="alert"
      data-testid="turn-failed"
      data-problem={problem.kind}
    >
      {problem.kind === 'rate'
        ? problem.retryAfterSeconds
          ? t('rate', { seconds: problem.retryAfterSeconds })
          : t('rateSoon')
        : problem.kind === 'credits'
          ? t.rich('credits', { billing })
          : t(problem.kind)}
    </p>
  );
}

/** "✓ Counting open WhatsApp conversations · done · 2s" - in the run's words and the interface language. */
function StepLine({ step }: { readonly step: ThreadStep }) {
  const t = useTurnTranslations('home.conversation.step');
  return (
    <li className={styles.step} data-status={step.status} data-testid={`step-${step.id}`}>
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
      <span dir="auto">{step.text}</span>
      <span className={styles.stepState}>{t(step.status)}</span>
      {step.durationMs !== null ? (
        <span className={styles.stepTime}>
          {t('seconds', { count: Math.round(step.durationMs / 1000) })}
        </span>
      ) : null}
      {step.status === 'waiting_approval' ? (
        // The decision is made in Approvals - on this request, not on the list.
        <Link
          href={
            step.approvalRequestId
              ? { pathname: '/approvals', query: { id: step.approvalRequestId } }
              : '/approvals'
          }
          className={styles.stepLink}
          data-testid={`step-${step.id}-approvals`}
        >
          {t('openApprovals')}
        </Link>
      ) : null}
    </li>
  );
}
