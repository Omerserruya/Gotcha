/**
 * Members by default (support mode, 2026-11-01).
 *
 * Every tenant that has been supported holds one hidden "GOTCHA Support" user
 * (kind = "support") that support-mode writes are attributed to. It must not
 * appear in the team list, the assignee picker, presence, seat counts or any
 * other listing. Lists and counts get kind = "member" unless the caller says
 * something about kind; lookups by id still find it, so a message or an
 * assignment attributed to it still resolves to "GOTCHA Support".
 */
const MEMBER_LIST_OPERATIONS = new Set(["findMany", "count", "aggregate", "groupBy"]);

export function applyMembersByDefault(model: string | undefined, operation: string, args: unknown): unknown {
  if (model !== "User" || !MEMBER_LIST_OPERATIONS.has(operation)) return args;
  const a = (args ?? {}) as Record<string, unknown>;
  const w = a.where as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && "kind" in w && w.kind !== undefined) return args;
  return { ...a, where: { ...(w ?? {}), kind: "member" } };
}

