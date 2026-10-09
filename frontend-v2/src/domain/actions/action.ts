import type { Capability } from '@/permissions/capability';

/**
 * The shape every business action shares.
 *
 * Refund, cancel order, return, update customer, send message: each has its
 * own inputs and its own endpoint, but the *lifecycle* is identical, and
 * writing that lifecycle out once is what stops each action growing its own
 * slightly different handling of approval, failure and retry.
 *
 *   availability → input → capability → approval → execution
 *                → pending → success | failure → result
 *
 * Nothing here executes anything. It is the contract the action
 * implementations will satisfy, so that a generic action surface - a button, a
 * confirmation dialog, an approval badge, a result toast - can drive any of
 * them without knowing which it is holding.
 */

/** Stable identifier, e.g. `commerce.order.refund`. Never a display string. */
export type ActionId = string;

export type ActionPhase =
  | 'idle'
  /** Collecting the operator's input. */
  | 'collecting'
  /** Submitted; awaiting the platform. */
  | 'executing'
  /** Accepted, but queued behind a human approval. */
  | 'awaiting_approval'
  /** Accepted and applied. */
  | 'succeeded'
  | 'failed';

export interface ActionOutcome<TResult> {
  readonly phase: ActionPhase;
  readonly result?: TResult;
  /** Present when the platform queued the action for approval. */
  readonly approvalId?: string;
  readonly error?: unknown;
}

/**
 * A business action.
 *
 * `capability` is separate from `execute` on purpose. The interface must be
 * able to ask "may this happen, and what would happen" without doing it -
 * that is what lets a disabled button explain itself, and what lets an
 * approval requirement be disclosed before the click rather than after.
 */
export interface ActionDefinition<TInput, TResult, TSubject> {
  readonly id: ActionId;
  /**
   * Whether the action applies to this subject at all, and if so on what
   * terms. Combines permissions with the subject's own state and the channel
   * or integration it depends on.
   */
  capability(subject: TSubject): Capability;
  /** Whether the action is destructive enough to warrant a confirmation. */
  readonly destructive?: boolean;
  execute(input: TInput, subject: TSubject, signal?: AbortSignal): Promise<ActionOutcome<TResult>>;
}
