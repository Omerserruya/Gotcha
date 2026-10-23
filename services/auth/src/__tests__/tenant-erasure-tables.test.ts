/**
 * A tenant delete reaches every tenant-scoped table.
 *
 * Reads schema.prisma and classifies every model that carries a tenantId:
 * reached by the Tenant cascade (directly or through a cascading parent),
 * deleted explicitly by eraseTenant, or kept on purpose as the money trail.
 * A model in none of the three is a table a delete silently orphans - which is
 * how OAuth tokens outlived their organization until 2026-10-23.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERASED_EXPLICITLY, KEPT_FINANCIAL } from "../services/tenant-erasure-tables";

const schema = readFileSync(join(__dirname, "../../../../packages/shared/prisma/schema.prisma"), "utf8");

interface Model { name: string; hasTenantId: boolean; cascadesTo: string[] }

function parse(): Map<string, Model> {
  const out = new Map<string, Model>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = m[2]!;
    const cascadesTo: string[] = [];
    for (const r of body.matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\(([^)]*)\)/gm)) {
      if (/fields:/.test(r[2]!) && /onDelete:\s*Cascade/.test(r[2]!)) cascadesTo.push(r[1]!);
    }
    out.set(m[1]!, { name: m[1]!, hasTenantId: /^\s*tenantId\s/m.test(body), cascadesTo });
  }
  return out;
}

const models = parse();
const delegate = (name: string) => name[0]!.toLowerCase() + name.slice(1);

function reachedByCascade(): Set<string> {
  const covered = new Set(["Tenant"]);
  for (let changed = true; changed;) {
    changed = false;
    for (const m of models.values()) {
      if (!covered.has(m.name) && m.cascadesTo.some((t) => covered.has(t))) {
        covered.add(m.name);
        changed = true;
      }
    }
  }
  return covered;
}

describe("every tenant-scoped table is accounted for", () => {
  const cascade = reachedByCascade();
  const explicit = new Set<string>(ERASED_EXPLICITLY);
  const kept = new Set(Object.keys(KEPT_FINANCIAL));

  it("no model with a tenantId is left orphaned by a delete", () => {
    const orphaned = [...models.values()]
      .filter((m) => m.hasTenantId && !cascade.has(m.name) && !explicit.has(delegate(m.name)) && !kept.has(m.name))
      .map((m) => m.name);
    expect(orphaned).toEqual([]);
  });

  it("every explicitly erased name is a real model with a tenantId", () => {
    const byDelegate = new Map([...models.values()].map((m) => [delegate(m.name), m]));
    for (const d of ERASED_EXPLICITLY) {
      expect(byDelegate.get(d), d).toBeDefined();
      expect(byDelegate.get(d)!.hasTenantId, d).toBe(true);
    }
  });

  it("nothing is both erased and kept", () => {
    for (const k of kept) expect(explicit.has(delegate(k)), k).toBe(false);
  });

  it("the token tables found surviving a delete are now erased", () => {
    for (const t of ["tenantIntegration", "tenantTool", "calendarAccount", "commerceConnection", "shopifyChatInstallation"]) {
      expect(explicit.has(t), t).toBe(true);
    }
  });

  it("the audit log is erased last, so the deletion's own row (written after) survives", () => {
    expect(ERASED_EXPLICITLY[ERASED_EXPLICITLY.length - 1]).toBe("auditLog");
  });

  it("children are erased before the parents they reference", () => {
    const at = (d: string) => ERASED_EXPLICITLY.indexOf(d as any);
    const byDelegate = new Map([...models.values()].map((m) => [delegate(m.name), m]));
    for (const d of ERASED_EXPLICITLY) {
      for (const parent of byDelegate.get(d)!.cascadesTo) {
        const p = at(delegate(parent));
        if (p >= 0) expect(at(d), `${d} before ${parent}`).toBeLessThan(p);
      }
    }
  });
});
