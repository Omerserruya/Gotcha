import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

/** `whoAnswers`'s link: Studio · Automations, where it is decided. */
export const automationsLink = (chunks: ReactNode) => (
  <Link href="/studio/automations">{chunks}</Link>
);

/**
 * Where an employee answers is not a field on the employee (Omer and
 * Backend, 2026-10-07): `AIAgent.channels` is read by nothing at runtime;
 * the playbook and the automations route conversations to it (`route_target`,
 * `hand_to_ai`). Until Backend's reachability read exists, this says where it
 * is decided, with the way there - never "nothing reaches it", which the old
 * field could not know.
 *
 * The words are the caller's (`employees.whoAnswers`, with `automationsLink`),
 * so a server and a client component render it alike.
 */
export function WhoAnswers({
  text,
  className,
}: {
  readonly text: ReactNode;
  readonly className?: string;
}) {
  return (
    <p className={className} data-testid="who-answers">
      {text}
    </p>
  );
}
