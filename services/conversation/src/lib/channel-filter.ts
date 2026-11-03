import { ChannelType } from "@prisma/client";

/**
 * The list's `channel` filter, read from the query: one channel, or several
 * as `channel=WHATSAPP,INSTAGRAM` (the phone's multi-select, 2026-11-03).
 *
 * ⚠⚠ IT WAS ASSIGNED STRAIGHT TO `where.channel`. `channel=a,b` went to
 *    Postgres as one enum value and `channel[]=a` handed Prisma an array:
 *    both ended in a 500. Every value is now checked against the schema's
 *    own enum, and an unknown one is a 400 by name - never a 500, and never
 *    silently dropped (a filter that quietly forgets a channel shows a list
 *    that looks narrowed and is not).
 *
 * ★ ONE VALUE KEEPS TODAY'S EXACT MATCH. Only a real list becomes `{ in }`,
 *   so every caller that sends one channel builds the same WHERE as before.
 *
 * @returns undefined when absent or empty (no filter); the distinct values otherwise.
 * @throws  an Error with `status: 400` naming the values that are not channels.
 */
export function parseChannelList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  // `channel=a&channel=b` and `channel[]=a` arrive as arrays; a list as a,b.
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))
    .map((v) => (typeof v === "string" ? v.trim() : v));
  const known = Object.values(ChannelType) as string[];
  const unknown = parts.filter((v) => typeof v !== "string" || (v !== "" && !known.includes(v)));
  if (unknown.length) {
    throw Object.assign(new Error(`unknown channel: ${unknown.map(String).join(",")}`), { status: 400 });
  }
  const list = Array.from(new Set(parts.filter((v): v is string => typeof v === "string" && v !== "")));
  return list.length ? list : undefined;
}

/** The WHERE for a parsed list: an exact match for one, `{ in }` for several. */
export function channelWhere(channels: readonly string[]): string | { in: string[] } {
  return channels.length === 1 ? channels[0]! : { in: [...channels] };
}
