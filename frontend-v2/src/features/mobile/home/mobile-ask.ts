import type { ThreadTurn } from '@/features/home/thread-turns';

/**
 * The pure parts of the phone's ask screen: what the dock's button is, and
 * whether a question can go. Apart from the screen so they are tested
 * without a stream, a router and a translation runtime.
 */

/** The thread's state as the hook reports it. */
type Opening = 'idle' | 'opening' | 'missing' | 'failed';

/**
 * The dock's one button: Stop while an answer is being written (and
 * "stopping" once pressed, until the stream says it stopped), otherwise Send.
 */
export function dockMode(last: ThreadTurn | undefined): 'send' | 'stop' | 'stopping' {
  if (last?.status !== 'running') return 'send';
  return last.cancelling ? 'stopping' : 'stop';
}

/**
 * Whether this text can be asked now: something to ask, no answer still
 * being written (the route answers 409 to a second one), and a thread that
 * opened - or none asked for. A thread that could not be opened takes no
 * question: it would start a new one under the old one's address.
 */
export function canAsk(text: string, last: ThreadTurn | undefined, opening: Opening): boolean {
  return text.trim() !== '' && dockMode(last) === 'send' && opening === 'idle';
}

/**
 * Where a step that waits on a person, or a proposed plan, is decided on the
 * phone: its own request when it names one, the queue otherwise. The
 * desktop's `/approvals?id=` is the website, which the app leaves for.
 */
export function approvalHref(approvalRequestId: string | null): string {
  return approvalRequestId
    ? `/m/approvals/${encodeURIComponent(approvalRequestId)}`
    : '/m/approvals';
}
