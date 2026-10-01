'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  claimConversation,
  closeConversation,
  returnToAi,
  transferConversation,
  type VerbResult,
} from './conversation-actions';
import styles from './Inbox.module.css';

/**
 * Who is driving this conversation, and how to change it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ TAKING CONTROL CAN MESSAGE THE CUSTOMER
 * ════════════════════════════════════════════════════════════════════════════
 * `claim()` ends in `sendAutoGreeting`, on claim **and on reclaim**. So the
 * button says so before it is pressed, and it is not drawn at all when the
 * conversation is already yours — a second press would greet the customer a
 * second time for no change in state.
 *
 * ── THE THREE VERBS, AND THE ONE THAT IS NOT HERE ──
 *   Take control        claim — from the AI, or from nobody
 *   Return to the AI    the only thing that clears the handover latch
 *   Transfer to someone reassign, to a named colleague
 *
 * **There is no "put back in the queue".** Omer ruled it out and the platform
 * agrees by accident: `release()` clears the assignment without clearing
 * `isHandedOver`, so a released conversation has no human AND the AI is still
 * switched off it. Nobody drives it and no screen says so.
 */
export function ConversationVerbs({
  conversationId,
  mine,
  handedOver,
  hasAiEmployee,
  greeting,
  colleagues,
  resolved,
}: {
  readonly conversationId: string;
  /** Is this conversation assigned to the person looking at it? */
  readonly mine: boolean;
  /** `isHandedOver` — a human has taken it, whoever that is. */
  readonly handedOver: boolean;
  /**
   * Is an AI employee bound to it? `null` when we could not find out, which
   * is not "no": `return-to-ai` 409s when there is none, and offering the
   * control on a guess is better than withholding it on one — the refusal is
   * harmless and says why, while a missing button is unexplainable.
   */
  readonly hasAiEmployee: boolean | null;
  /**
   * Does the workspace have an auto-greeting? `null` means we could not ask:
   * `GET /settings/auto-greeting` is ADMIN-only, and most people pressing
   * this button are not admins. Three states, and the unknown one hedges
   * rather than promising silence.
   */
  readonly greeting: boolean | null;
  readonly colleagues: readonly { readonly id: string; readonly name: string }[];
  /**
   * Whether this conversation is already closed.
   *
   * ⚠ Resolve is not offered on something already resolved. The route would
   *   accept it — `close` on a CLOSED conversation is a no-op — and a button
   *   whose only effect is nothing is how a screen teaches somebody that its
   *   controls are decorative.
   */
  readonly resolved: boolean;
}) {
  const t = useTranslations('inbox.verbs');
  const [result, setResult] = useState<VerbResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [transferTo, setTransferTo] = useState('');

  function run(verb: () => Promise<VerbResult>) {
    setResult(null);
    startTransition(async () => setResult(await verb()));
  }

  return (
    <div className={styles.verbs} data-testid={`verbs-${conversationId}`}>
      {/*
        ★★ NOT DRAWN WHEN IT IS ALREADY YOURS.
        Re-claiming is allowed by the route and changes nothing — except that
        it greets the customer again. A button whose only effect is a second
        "Hi, I'm Dana, taking over from here" is worse than no button.
      */}
      {!mine ? (
        <button
          type="button"
          className={styles.verbButton}
          data-testid={`claim-${conversationId}`}
          disabled={isPending}
          onClick={() => run(() => claimConversation(conversationId))}
        >
          {t('claim')}
        </button>
      ) : null}

      {/*
        Only once a human has it. `return-to-ai` clears a latch that is not
        set on a conversation the AI is already answering, so offering it
        there would be a control for a state the reader is already in.
      */}
      {handedOver ? (
        <button
          type="button"
          className={styles.verbButton}
          data-testid={`return-${conversationId}`}
          disabled={isPending}
          onClick={() => run(() => returnToAi(conversationId))}
        >
          {t('returnToAi')}
        </button>
      ) : null}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ RESOLVE — 02's THIRD BUTTON, AND THE ROUTE EXISTED ALL ALONG
        ════════════════════════════════════════════════════════════════════
        The design's conversation header carries three: Assign · Pause AI ·
        Resolve, the last one filled `#121212`. We drew one.

        ★ `closeConversation` posts to `/conversations/{id}/close`, which the
          platform has always had — it was missing from THIS app, not from
          the API. Measured against the OpenAPI rather than assumed.

        ⚠ Not offered on something already closed: the route accepts it as a
          no-op, and a button whose only effect is nothing teaches a reader
          that the controls are decorative.
      */}
      {!resolved ? (
        <button
          type="button"
          className={styles.verbButtonPrimary}
          data-testid={`resolve-${conversationId}`}
          disabled={isPending}
          onClick={() => run(() => closeConversation(conversationId))}
        >
          {t('resolve')}
        </button>
      ) : null}

      {/*
        ★ TRANSFER IS FOR THE PERSON HOLDING IT. The route refuses a
        non-admin transferring a conversation that is not theirs, so drawing
        it elsewhere would be a control that answers 403 every time.
      */}
      {mine && colleagues.length > 0 ? (
        <span className={styles.verbTransfer}>
          <label className={styles.verbLabel} htmlFor={`transfer-${conversationId}`}>
            {t('transferTo')}
          </label>
          <select
            id={`transfer-${conversationId}`}
            className={styles.verbSelect}
            data-testid={`transfer-select-${conversationId}`}
            value={transferTo}
            disabled={isPending}
            onChange={(event) => setTransferTo(event.target.value)}
          >
            <option value="">{t('transferPick')}</option>
            {colleagues.map((colleague) => (
              <option key={colleague.id} value={colleague.id}>
                {colleague.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.verbButton}
            data-testid={`transfer-${conversationId}`}
            disabled={isPending || transferTo === ''}
            onClick={() => run(() => transferConversation(conversationId, transferTo))}
          >
            {t('transfer')}
          </button>
        </span>
      ) : null}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ WHAT THE CUSTOMER WILL SEE, BEFORE THE BUTTON IS PRESSED
        ════════════════════════════════════════════════════════════════════
        Claiming enqueues the workspace's greeting on the customer's channel,
        with the agent's name substituted in. An agent who does not know that
        is about to send a stranger a message by pressing a button labelled
        "take control".

        Three states, because we cannot always find out: the setting is
        readable by admins only, and most people pressing this are not
        admins. `false` — a workspace with no greeting — says nothing at all,
        since a warning about something that cannot happen is noise on every
        conversation.
      */}
      {!mine && greeting !== false ? (
        <p className={styles.verbNote} data-testid={`greeting-${conversationId}`}>
          {greeting === true ? t('greetingSends') : t('greetingMaybe')}
        </p>
      ) : null}

      {/*
        ★ THE AI CANNOT BE HANDED BACK TO IF THERE IS NONE.
        Said as a fact next to the control rather than by removing it: the
        route answers 409 either way, and a reader who can see the button and
        the reason can act on the reason.
      */}
      {handedOver && hasAiEmployee === false ? (
        <p className={styles.verbNote} data-testid={`no-ai-${conversationId}`}>
          {t('noAiEmployee')}
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className={styles.verbProblem} data-testid={`verb-problem-${conversationId}`}>
          {t(`problem.${result.reason}` as 'problem.failed')}
        </p>
      ) : null}
    </div>
  );
}
