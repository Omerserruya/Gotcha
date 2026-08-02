/**
 * The tenant access matrix.
 *
 * One table, asserted exhaustively, because this is the boundary that decides
 * whether an unpaid or suspended organization can reach the paid product.
 */
import { describe, it, expect } from "vitest";
import type { TenantStatus } from "@prisma/client";
import {
  evaluateTenantAccess,
  tenantAccessErrorBody,
  type TenantAccessScope,
} from "../tenant-access-policy";

const STATUSES: TenantStatus[] = [
  "PENDING_ADMIN_SETUP",
  "PENDING_ONBOARDING",
  "PENDING_PAYMENT",
  "ACTIVE",
  "SUSPENDED",
];
const SCOPES: TenantAccessScope[] = ["FULL_APPLICATION", "ONBOARDING", "PAYMENT_SETUP", "IDENTITY"];

describe("every status has explicit, intentional behaviour", () => {
  it("no status falls through to a default branch", () => {
    for (const status of STATUSES) {
      for (const scope of SCOPES) {
        expect(() => evaluateTenantAccess(status, scope)).not.toThrow();
      }
    }
  });

  it("throws loudly on an unknown status rather than allowing it", () => {
    expect(() => evaluateTenantAccess("SOMETHING_NEW" as TenantStatus, "FULL_APPLICATION")).toThrow(
      /unhandled tenant status/,
    );
  });

  it("identity is permitted for every status, including suspended", () => {
    // Locking someone out of auth/MFA/logout because their org owes money makes
    // the problem unfixable by the person best placed to fix it.
    for (const status of STATUSES) {
      expect(evaluateTenantAccess(status, "IDENTITY").allow, status).toBe(true);
    }
  });
});

describe("the matrix", () => {
  const decide = (s: TenantStatus, sc: TenantAccessScope) => evaluateTenantAccess(s, sc).allow;

  it("ACTIVE: everything", () => {
    for (const scope of SCOPES) expect(decide("ACTIVE", scope)).toBe(true);
  });

  it("PENDING_ADMIN_SETUP: identity only", () => {
    expect(decide("PENDING_ADMIN_SETUP", "FULL_APPLICATION")).toBe(false);
    expect(decide("PENDING_ADMIN_SETUP", "ONBOARDING")).toBe(false);
    expect(decide("PENDING_ADMIN_SETUP", "PAYMENT_SETUP")).toBe(false);
    expect(decide("PENDING_ADMIN_SETUP", "IDENTITY")).toBe(true);
  });

  it("PENDING_ONBOARDING: onboarding, not the paid product", () => {
    expect(decide("PENDING_ONBOARDING", "ONBOARDING")).toBe(true);
    expect(decide("PENDING_ONBOARDING", "FULL_APPLICATION")).toBe(false);
  });

  it("PENDING_PAYMENT: payment setup and onboarding, never the paid product", () => {
    expect(decide("PENDING_PAYMENT", "PAYMENT_SETUP")).toBe(true);
    expect(decide("PENDING_PAYMENT", "ONBOARDING")).toBe(true);
    expect(decide("PENDING_PAYMENT", "FULL_APPLICATION")).toBe(false);
  });

  it("SUSPENDED: stricter than PENDING_PAYMENT - cannot self-serve back in", () => {
    expect(decide("SUSPENDED", "FULL_APPLICATION")).toBe(false);
    expect(decide("SUSPENDED", "ONBOARDING")).toBe(false);
    // The distinction that matters: an unpaid tenant may pay; a suspended one may not.
    expect(decide("SUSPENDED", "PAYMENT_SETUP")).toBe(false);
    expect(decide("PENDING_PAYMENT", "PAYMENT_SETUP")).toBe(true);
  });
});

describe("denials are safe and actionable", () => {
  it("PENDING_PAYMENT returns 402 with a structured code and a route", () => {
    const d = evaluateTenantAccess("PENDING_PAYMENT", "FULL_APPLICATION");
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error("unreachable");
    expect(d.httpStatus).toBe(402);
    expect(d.code).toBe("TENANT_PAYMENT_REQUIRED");
    expect(d.redirectPath).toBe("/checkout/payment-required");
    // Previously this said "suspended", which was both wrong and unactionable.
    expect(d.message.toLowerCase()).not.toContain("suspend");
  });

  it("the error body leaks nothing", () => {
    const d = evaluateTenantAccess("PENDING_PAYMENT", "FULL_APPLICATION");
    if (d.allow) throw new Error("unreachable");
    const body = JSON.stringify(tenantAccessErrorBody(d));
    for (const forbidden of ["tenantId", "planId", "icount", "token", "pageId", "amount"]) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("customer-facing messages name no provider and no billing internals", () => {
    for (const status of STATUSES) {
      const d = evaluateTenantAccess(status, "FULL_APPLICATION");
      if (d.allow) continue;
      const m = d.message.toLowerCase();
      for (const forbidden of ["icount", "token", "paypage", "cc/bill", "provider"]) {
        expect(m, `${status}: ${d.message}`).not.toContain(forbidden);
      }
    }
  });
});
