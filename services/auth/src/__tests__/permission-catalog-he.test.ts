/**
 * ★ The permission catalogue in the reader's language (2026-10-08, the Hebrew
 * sweep): GET /api/permissions/catalog answered every permission's name and
 * description, and every built-in role's, in English only.
 *   - Hebrew for a Hebrew reader (the request's language, else their own,
 *     else the workspace's), in permissions, byDomain and builtinRoles alike
 *   - English otherwise, exactly as stored; keys, domains, scopes untouched
 *   - every permission and every built-in role has Hebrew, and all of it
 *     keeps the house rules
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PERMISSIONS, BUILTIN_ROLES } from "@chatcenter/shared";
import { PERMISSION_HE, ROLE_HE } from "../lib/permission-catalog-he";
import { hebrewHouseRuleViolations } from "./helpers/hebrew-house-rules";

const H = vi.hoisted(() => ({ userLocale: "en" }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    resolveEffectiveLocale: async () => ({ effective: H.userLocale }),
  };
});

import router from "../routes/permissions";

const app = express();
app.use(express.json());
app.use("/api/permissions", router);
const catalog = async (headers: Record<string, string> = {}, q = "") => (await request(app).get(`/api/permissions/catalog${q}`).set(headers)).body.data;

beforeEach(() => { H.userLocale = "en"; });

describe("★ the catalogue in the reader's language", () => {
  it("Hebrew for a Hebrew reader, in all three places", async () => {
    const d = await catalog({ "Accept-Language": "he" });
    const read = d.permissions.find((p: any) => p.key === "conversation:messages:read");
    expect(read).toMatchObject({ key: "conversation:messages:read", domain: "conversation", displayName: PERMISSION_HE["conversation:messages:read"]!.displayName, description: PERMISSION_HE["conversation:messages:read"]!.description });
    expect(d.byDomain.conversation.find((p: any) => p.key === "conversation:messages:read").displayName).toBe(read.displayName);
    expect(d.builtinRoles.find((r: any) => r.key === "owner")).toMatchObject({ name: ROLE_HE.owner!.name, description: ROLE_HE.owner!.description });
    expect(d.scopes).toEqual(["own", "team", "department", "workspace"]);
  });

  it("English for an English reader, exactly as stored", async () => {
    const d = await catalog({ "Accept-Language": "en" });
    expect(d.permissions).toEqual(JSON.parse(JSON.stringify(PERMISSIONS)));
    expect(d.builtinRoles.find((r: any) => r.key === "owner").name).toBe("Owner");
  });

  it("no language asked: the reader's own (else the workspace's)", async () => {
    H.userLocale = "he";
    const d = await catalog();
    expect(d.builtinRoles.find((r: any) => r.key === "agent").name).toBe(ROLE_HE.agent!.name);
    // ?locale wins over the user's own.
    expect((await catalog({}, "?locale=en")).builtinRoles.find((r: any) => r.key === "agent").name).toBe("Agent");
  });
});

describe("★ the Hebrew covers everything and keeps the house rules", () => {
  it("every permission and every built-in role has Hebrew, and nothing else does", () => {
    expect(Object.keys(PERMISSION_HE).sort()).toEqual(PERMISSIONS.map((p) => p.key).sort());
    expect(Object.keys(ROLE_HE).sort()).toEqual(Object.keys(BUILTIN_ROLES).sort());
  });

  it("all of it passes the sweep", () => {
    const v = [
      ...Object.entries(PERMISSION_HE).flatMap(([k, x]) => [...hebrewHouseRuleViolations(`${k} name`, x.displayName), ...hebrewHouseRuleViolations(`${k} description`, x.description)]),
      ...Object.entries(ROLE_HE).flatMap(([k, x]) => [...hebrewHouseRuleViolations(`role ${k} name`, x.name), ...hebrewHouseRuleViolations(`role ${k} description`, x.description)]),
    ];
    expect(v).toEqual([]);
  });
});
