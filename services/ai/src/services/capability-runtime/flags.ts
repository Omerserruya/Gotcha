/**
 * Capability Runtime feature flags (Slice 3C) — capability-level, per-tenant,
 * env-driven for INSTANT rollback (flip the env, recreate, no deploy).
 *
 * Calendar cutover: when enabled for a tenant, calendar tool executions route
 * through the new Capability Runtime; otherwise the legacy handler path runs
 * unchanged. Scoped to ONE capability so the blast radius is exactly calendar.
 */

function tenantAllowed(allowRaw: string | undefined, tenantId: string): boolean {
  const allow = (allowRaw || "").trim();
  if (allow === "" || allow === "*") return true; // empty/"*" = all tenants
  return allow.split(",").map((s) => s.trim()).filter(Boolean).includes(tenantId);
}

/** Execute calendar operations through the Capability Runtime for this tenant? */
export function isCalendarRuntimeEnabled(tenantId: string): boolean {
  if (process.env.CAPABILITY_RUNTIME_CALENDAR !== "1") return false;
  return tenantAllowed(process.env.CAPABILITY_RUNTIME_CALENDAR_TENANTS, tenantId);
}

/** Shadow-compare calendar (3B) for this tenant? (kept here for cohesion.) */
export function isCalendarShadowEnabled(tenantId: string): boolean {
  if (process.env.CAPABILITY_RUNTIME_SHADOW !== "1") return false;
  return tenantAllowed(process.env.CAPABILITY_RUNTIME_SHADOW_TENANTS, tenantId);
}
