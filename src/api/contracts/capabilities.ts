import { z } from 'zod';

/**
 * What GOTCHA is allowed to do — screen 10.
 *
 * Shapes read from `services/ai/src/routes/tool-permissions.ts`.
 *
 * ── THE THIRD STATE THE DESIGN DOES NOT HAVE ──
 * The design promises *"Three settings for everything: do it, ask me first,
 * never."* The route returns a fourth condition that is none of the three:
 * **`scopeBlocked`** — a capability that is switched on and **still cannot
 * run**, because the integration behind it was connected without the OAuth
 * scope it needs.
 *
 * *"Allowed"* and *"able"* are different, and a screen showing only the first
 * tells somebody a capability works when it cannot. That is this screen's
 * *"approved but never ran"*.
 *
 * ── USAGE COUNTS ARE NOT AVAILABLE ──
 * The design shows *"Used 1,840 times this week · never failed"* per system
 * and *"Used 612 times"* per capability. The only usage route reads
 * `ToolExecution`, which has **zero rows on this tenant**, and would report
 * every tool as `"unknown"` anyway because it selects the catalog name and
 * never the denormalised `toolName` added to survive a disconnect.
 *
 * The populated table is `ToolExecutionRequest` — 164 rows — and **no route
 * exposes it**. So the screen does not draw usage, and says why.
 *
 * ── `allowModification` IS HERE, AND NOTHING READS IT ──
 * The response carries it per tool. It is the permission that governs editing
 * an action's parameters before approving, and **no code path consults it**.
 * No control is drawn for it.
 */

/** How a capability is treated. The design's three, and they are real. */
export const CAPABILITY_MODES = ['allowed', 'ask_first', 'never'] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];

export const capabilitySchema = z.object({
  toolName: z.string().min(1),
  /** `system` | `action` | `integration`. */
  kind: z.string().default('system'),
  category: z.string().default(''),
  description: z.string().default(''),
  enabled: z.boolean().default(false),
  /** True when nobody has overridden the platform default for this tool. */
  isDefault: z.boolean().default(true),
  /** `low` | `medium` | `high` — how much damage it can do. */
  riskGroup: z.string().nullable().default(null),
  /** Slug of the integration behind it, when there is one. */
  integration: z.string().nullable().default(null),
  integrationConnected: z.boolean().default(false),
  /**
   * **Switched on, and unable to run.** The integration is connected but was
   * granted without a scope this capability needs.
   */
  scopeBlocked: z.boolean().default(false),
  missingScopes: z.array(z.string()).default([]),
  /**
   * Carried by the route and **read by nothing**. It governs editing an
   * action's parameters before approving, and no code path consults it, so
   * no control is drawn for it.
   */
  allowModification: z.boolean().default(false),
});

export type Capability = z.infer<typeof capabilitySchema>;
export const capabilityListSchema = z.array(capabilitySchema);

/**
 * What this capability can actually do right now.
 *
 * Deliberately not a boolean. **"Off", "on", and "on but unable to run" are
 * three different answers**, and collapsing the last into either of the
 * others is how somebody learns from a customer that a refund never happened.
 */
export type CapabilityState = 'off' | 'blocked' | 'on';

export function capabilityState(capability: Capability): CapabilityState {
  if (!capability.enabled) return 'off';
  // Checked BEFORE "on": a blocked capability reports as enabled, and that is
  // exactly the reading this function exists to prevent.
  if (capability.scopeBlocked) return 'blocked';
  return 'on';
}

/** Capabilities that are on and cannot run. The row that matters most. */
export function blockedCapabilities(capabilities: readonly Capability[]): readonly Capability[] {
  return capabilities.filter((c) => capabilityState(c) === 'blocked');
}

/**
 * Grouped by the system they belong to, in the design's shape.
 *
 * `integration` is null for built-in capabilities, which are their own group
 * rather than being hidden — GOTCHA can escalate to a human without any
 * integration connected, and that is worth seeing beside the rest.
 */
export interface CapabilityGroup {
  readonly key: string;
  readonly integration: string | null;
  readonly capabilities: readonly Capability[];
}

export function groupBySystem(capabilities: readonly Capability[]): readonly CapabilityGroup[] {
  const groups = new Map<string, Capability[]>();
  for (const capability of capabilities) {
    const key = capability.integration ?? '';
    const existing = groups.get(key);
    if (existing) existing.push(capability);
    else groups.set(key, [capability]);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key: key || 'built-in',
      integration: key || null,
      capabilities: items,
    }))
    .sort((a, b) => b.capabilities.length - a.capabilities.length);
}
