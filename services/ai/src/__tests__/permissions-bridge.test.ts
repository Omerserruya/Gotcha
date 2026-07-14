/**
 * Permissions bridge - RBAC home → kernel allow-list projection (P1-1).
 * Pure-function tests over deriveAllowedOperations; loadToolGrants is a thin
 * Prisma read exercised by the live stack.
 */

import { describe, it, expect } from "vitest";
import { deriveAllowedOperations, type ToolGrants } from "../services/agent-loop/permissions-bridge";

const WORLD_OPS = [
  "CHECK_AVAILABILITY",
  "BOOK_MEETING",
  "SEARCH_KNOWLEDGE",
  "SEARCH_CUSTOMER",
  "GET_CUSTOMER_CONTEXT",
  "UPSERT_CUSTOMER",
  "ADD_NOTE",
  "custom.check_inventory",
];

const grants = (governed: boolean, slugs: string[] = []): ToolGrants => ({
  governed,
  allowedToolSlugs: new Set(slugs),
});

describe("deriveAllowedOperations", () => {
  it("ungoverned agent → [] (unrestricted, kernel convention)", () => {
    expect(deriveAllowedOperations(grants(false), WORLD_OPS)).toEqual([]);
  });

  it("governed agent with CRM read+write+note tools → full CRM surface + ungoverned domains", () => {
    const out = deriveAllowedOperations(
      grants(true, ["contact_search", "create_lead", "add_lead_note"]),
      WORLD_OPS,
    );
    expect(out).toContain("SEARCH_CUSTOMER");
    expect(out).toContain("GET_CUSTOMER_CONTEXT");
    expect(out).toContain("UPSERT_CUSTOMER");
    expect(out).toContain("ADD_NOTE");
    // Domains governed elsewhere always pass through.
    expect(out).toContain("BOOK_MEETING");
    expect(out).toContain("SEARCH_KNOWLEDGE");
    expect(out).toContain("custom.check_inventory");
  });

  it("governed agent with only read tools → CRM writes excluded", () => {
    const out = deriveAllowedOperations(grants(true, ["customer_lookup", "get_contact"]), WORLD_OPS);
    expect(out).toContain("SEARCH_CUSTOMER");
    expect(out).not.toContain("UPSERT_CUSTOMER");
    expect(out).not.toContain("ADD_NOTE");
    expect(out).toContain("BOOK_MEETING"); // calendar untouched by tool grants
  });

  it("governed agent with NO allowed tools → CRM ops all excluded, rest passes", () => {
    const out = deriveAllowedOperations(grants(true), WORLD_OPS);
    expect(out).not.toContain("SEARCH_CUSTOMER");
    expect(out).not.toContain("UPSERT_CUSTOMER");
    expect(out).toContain("SEARCH_KNOWLEDGE");
  });

  it("governed agent facing a world of ONLY governed ops never returns [] (would mean unrestricted)", () => {
    const out = deriveAllowedOperations(grants(true), ["SEARCH_CUSTOMER", "UPSERT_CUSTOMER"]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("SEARCH_CUSTOMER");
    expect(out).not.toContain("UPSERT_CUSTOMER");
  });
});
