import type { QueueChannelFilter } from '@/features/inbox/inbox-views';

/**
 * One tick in the phone's channel sheet: on if it was off, off if it was on -
 * and the set kept in the sheet's own order, so the same ticks always make
 * the same address (`channel=WHATSAPP,INSTAGRAM`, never the other way round
 * for the same choice).
 */
export function toggleChannel(
  picked: readonly QueueChannelFilter[],
  channel: QueueChannelFilter,
  order: readonly QueueChannelFilter[],
): readonly QueueChannelFilter[] {
  const next = new Set(picked);
  if (next.has(channel)) next.delete(channel);
  else next.add(channel);
  const ranked = order.filter((c) => next.has(c));
  // A ticked channel the sheet no longer draws keeps its place at the end.
  return [...ranked, ...[...next].filter((c) => !order.includes(c))];
}
