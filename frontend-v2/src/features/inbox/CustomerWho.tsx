import { PersonName } from '@/features/customers/PersonName';

import { customerLabel } from '@/lib/customer-label';

/**
 * Who the conversation is with: the name, else the handle (a phone reads
 * "052-123-4567"), else `unnamed` ("Someone"). The chain is lib/customer-label.ts,
 * the same one the alerts use.
 *
 * A phone is all weak characters: `dir="ltr"`, or a Hebrew line reverses it.
 */
export function CustomerWho({
  row,
  unnamed,
}: {
  readonly row: Parameters<typeof customerLabel>[0];
  readonly unnamed: string;
}) {
  const label = customerLabel(row);
  if (label === null) return <>{unnamed}</>;
  if (label.kind === 'name') return <PersonName name={label.name} />;
  return (
    <bdi dir="ltr" data-testid="customer-handle">
      {label.handle}
    </bdi>
  );
}
