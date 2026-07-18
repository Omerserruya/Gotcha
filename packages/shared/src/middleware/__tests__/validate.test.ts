import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { validate } from "../validate";

function run(schema: any, body: any) {
  const req: any = { body };
  const res: any = {
    statusCode: 0,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  const next = vi.fn();
  validate(schema)(req, res, next);
  return { req, res, next };
}

describe("validate() strips unknown keys (mass-assignment defense)", () => {
  const schema = z.object({ name: z.string().optional(), isActive: z.boolean().optional() });

  it("removes attacker-supplied extra keys from req.body", () => {
    const { req, next } = run(schema, { name: "ok", role: "ADMIN", authentikSubject: "victim", tenantId: "other" });
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ name: "ok" });
    expect(req.body.role).toBeUndefined();
    expect(req.body.authentikSubject).toBeUndefined();
    expect(req.body.tenantId).toBeUndefined();
  });

  it("keeps all schema-defined fields", () => {
    const { req } = run(schema, { name: "n", isActive: true });
    expect(req.body).toEqual({ name: "n", isActive: true });
  });

  it("400s on invalid input and does not call next", () => {
    const { res, next } = run(schema, { name: 123 });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });
});
