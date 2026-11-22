/**
 * "A new user joined your organization through your email domain" (2026-11-22).
 *
 * The sentence is fixed wording, so it is pinned letter for letter in both
 * languages. The notice goes to the organization's admins, in the app only:
 * no email, no push, no WhatsApp.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await import("./helpers/platform-sender-double")).platformSenderDouble,
  ...(await importOriginal<any>()),
  withCrossTenantAccess: (fn: any) => fn(),
  prisma: {},
}));

import { renderTemplate } from "../services/templates";
import { defaultRoute, wantsPush } from "../services/notification-engine.service";
import { wantsWhatsApp } from "../services/whatsapp-notice.service";
import { EVENT_CATALOGUE } from "../services/event-catalogue";
import type { SystemEvent } from "../services/event-emitter.service";

const ev = (data: Record<string, unknown>) =>
  ({ id: "e1", type: "member.joined_by_domain", tenantId: "t_acme", data, metadata: { timestamp: "2026-11-22T16:00:00.000Z" } }) as unknown as SystemEvent;
const NOA = { userId: "u_noa", name: "Noa Levi", email: "noa@acme-flowers.co.il", domain: "acme-flowers.co.il" };

describe("the wording", () => {
  it("English, as approved", () => {
    expect(renderTemplate(ev(NOA), "en")).toEqual({
      title: "A new user joined your organization",
      body: "A new user joined your organization through your email domain: Noa Levi (noa@acme-flowers.co.il)",
      link: "/settings/people",
    });
  });

  it("Hebrew, as approved", () => {
    expect(renderTemplate(ev(NOA), "he")).toEqual({
      title: "משתמש חדש הצטרף לארגון",
      body: "משתמש חדש הצטרף לארגון דרך דומיין האימייל שלכם: Noa Levi (noa@acme-flowers.co.il)",
      link: "/settings/people",
    });
  });

  it("a Hebrew name is printed as the person typed it", () => {
    expect(renderTemplate(ev({ ...NOA, name: "נועה לוי" }), "he").body).toBe(
      "משתמש חדש הצטרף לארגון דרך דומיין האימייל שלכם: נועה לוי (noa@acme-flowers.co.il)",
    );
  });

  it("a missing name or address leaves no empty brackets and no dangling colon", () => {
    expect(renderTemplate(ev({ email: NOA.email }), "en").body).toBe("A new user joined your organization through your email domain: noa@acme-flowers.co.il");
    expect(renderTemplate(ev({ name: "Noa Levi" }), "en").body).toBe("A new user joined your organization through your email domain: Noa Levi");
    expect(renderTemplate(ev({}), "en").body).toBe("A new user joined your organization through your email domain");
    expect(renderTemplate(ev({}), "he").body).toBe("משתמש חדש הצטרף לארגון דרך דומיין האימייל שלכם");
  });

  it("no dash of any kind and no slash form", () => {
    for (const locale of ["en", "he"] as const) {
      const t = renderTemplate(ev(NOA), locale);
      expect(`${t.title} ${t.body}`).not.toMatch(/[\u2013\u2014]|\/ה|\/ת/);
    }
  });
});

describe("who is told, and how", () => {
  it("the organization's admins, in the app only", () => {
    expect(defaultRoute(ev(NOA))).toEqual({
      priority: "MEDIUM", conditions: null, departmentId: null,
      channels: ["in_app"],
      recipients: { type: "tenant_owner" },
    });
  });

  it("no push and no WhatsApp", () => {
    expect(wantsPush("member.joined_by_domain")).toBe(false);
    expect(wantsWhatsApp("member.joined_by_domain")).toBe(false);
  });

  it("is listed as a live event, raised by the auth service", () => {
    const entry = EVENT_CATALOGUE.find((e) => e.key === "member.joined_by_domain");
    expect(entry).toMatchObject({
      label: "A new user joined through your email domain",
      group: "operations",
      emitted: true,
      emitters: [{ file: "services/auth/src/services/domain-join.service.ts", via: "notificationsQueue" }],
    });
  });
});
