/**
 * Skill registry + composer.
 *
 * System skills register themselves at module load via `defineSkill()`.
 * The composer resolves a worker's `skillIds[]` against the registry and
 * concatenates renderer output in a deterministic order.
 *
 * Determinism contract:
 *   compose(ctx, ids) === compose(ctx, ids)   // byte-for-byte
 *   compose(ctx, [a,b]) !== compose(ctx, [b,a])   // order matters
 *
 * Order = order of `skillIds[]` in the worker config. Within a kind,
 * the worker author controls priority.
 */

import type {
  AISkill,
  RegisteredSkill,
  SkillRenderContext,
  SkillRenderer,
  ComposedSkills,
} from "../types";

const REGISTRY = new Map<string, RegisteredSkill>();

/**
 * Register a skill. Called at module load time by every `skills/*` file.
 * Throws if `id` is already registered (catches accidental shadowing).
 */
export function defineSkill(
  meta: Omit<AISkill, "content"> & { render: SkillRenderer },
): void {
  const { render, ...rest } = meta;
  if (REGISTRY.has(rest.id)) {
    throw new Error(`[skills] Duplicate skill id registered: ${rest.id}`);
  }
  REGISTRY.set(rest.id, { meta: rest, render });
}

/** Lookup a registered skill. Returns undefined if missing. */
export function getSkill(id: string): RegisteredSkill | undefined {
  return REGISTRY.get(id);
}

/** Snapshot of registered skill metadata. Used by the worker editor UI. */
export function listSkillMetadata(): Array<Omit<AISkill, "content">> {
  return Array.from(REGISTRY.values()).map((s) => s.meta);
}

/** Test-only: clear the registry. Never call from production code. */
export function __clearRegistryForTests(): void {
  REGISTRY.clear();
}

/**
 * Compose a worker's skill set into a single prompt fragment + tool list.
 *
 * Behaviour:
 *  - Skills are rendered in `skillIds` order
 *  - Empty/whitespace-only renders are dropped
 *  - Fragments joined with a stable separator
 *  - Missing skill ids are reported via `missing` (NOT silently dropped)
 *
 * The output is byte-stable for a given `(ctx, skillIds)` — this is the
 * load-bearing property for OpenAI prefix caching.
 */
export function composeSkills(
  ctx: SkillRenderContext,
  skillIds: string[],
): ComposedSkills & { missing: string[] } {
  const parts: string[] = [];
  const toolsAdded: string[] = [];
  const toolsRequired: string[] = [];
  const used: string[] = [];
  const missing: string[] = [];

  for (const id of skillIds) {
    const reg = REGISTRY.get(id);
    if (!reg) {
      missing.push(id);
      continue;
    }
    const fragment = reg.render(ctx);
    if (fragment && fragment.trim()) {
      parts.push(fragment.trim());
      used.push(id);
    }
    for (const t of reg.meta.toolsAdded) {
      if (!toolsAdded.includes(t)) toolsAdded.push(t);
    }
    for (const t of reg.meta.toolsRequired) {
      if (!toolsRequired.includes(t)) toolsRequired.push(t);
    }
  }

  return {
    text: parts.join("\n\n---\n\n"),
    toolsAdded,
    toolsRequired,
    skillIds: used,
    missing,
  };
}
