import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createHealthRouter } from "../routes/health";
import type { Redis } from "ioredis";

function makeApp(ready: () => boolean, pingResult: string | Error) {
  const app = express();
  const redis = {
    ping: vi.fn().mockImplementation(() => {
      if (pingResult instanceof Error) return Promise.reject(pingResult);
      return Promise.resolve(pingResult);
    }),
  } as unknown as Redis;
  app.use("/", createHealthRouter({ redis, ready }));
  return app;
}

describe("GET /healthz", () => {
  it("always returns 200 with {status:'ok'}", async () => {
    const app = makeApp(() => false, new Error("redis down"));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /readyz", () => {
  it("returns 200 when ready and redis pings PONG", async () => {
    const app = makeApp(() => true, "PONG");
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ready: true });
  });

  it("returns 503 when ready() returns false (even if redis is healthy)", async () => {
    const app = makeApp(() => false, "PONG");
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ready: false });
  });

  it("returns 503 when redis ping fails", async () => {
    const app = makeApp(() => true, new Error("connection refused"));
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ready: false });
  });

  it("returns 503 when redis ping times out (>300ms)", async () => {
    const app = express();
    const redis = {
      ping: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("PONG"), 500))
      ),
    } as unknown as Redis;
    app.use("/", createHealthRouter({ redis, ready: () => true }));
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ready: false });
  }, 2000);
});
