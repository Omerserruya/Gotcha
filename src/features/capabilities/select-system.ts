import type { Capability } from '@/api/contracts/capabilities';
import { isConnected, type Integration } from '@/api/contracts/integrations';

/**
 * Which system 10's detail shows, and its actions.
 *
 * `?system=` names a connected slug or `builtin` (the actions that belong to
 * no provider). Anything else — absent, unknown, or a system that is not
 * connected — falls back to the first connected system that brings actions,
 * else the built-in ones: the detail is never empty while there is
 * something to show.
 */
export function selectSystem(
  wanted: string | undefined,
  capabilities: readonly Capability[],
  integrations: readonly Integration[],
): {
  readonly integration: Integration | null;
  readonly actions: readonly Capability[];
  readonly selected: string;
} {
  const connected = integrations.filter(isConnected);
  const actionsOf = (slug: string | null) =>
    capabilities.filter((capability) => (capability.integration ?? null) === slug);

  if (wanted === 'builtin')
    return { integration: null, actions: actionsOf(null), selected: 'builtin' };
  const asked = connected.find((entry) => entry.slug === wanted);
  if (asked) return { integration: asked, actions: actionsOf(asked.slug), selected: asked.slug };

  const first = connected.find((entry) => actionsOf(entry.slug).length > 0);
  if (first) return { integration: first, actions: actionsOf(first.slug), selected: first.slug };
  return { integration: null, actions: actionsOf(null), selected: 'builtin' };
}

/** How many actions each system brings, by slug. */
export function actionCounts(capabilities: readonly Capability[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const capability of capabilities) {
    if (capability.integration) {
      counts[capability.integration] = (counts[capability.integration] ?? 0) + 1;
    }
  }
  return counts;
}
