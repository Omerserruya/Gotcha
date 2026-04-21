import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { buildMetrics } from "../metrics/metrics";
import { createMetricsRouter } from "../routes/metrics";

function makeApp() {
  const app = express();
  const metrics = buildMetrics();
  app.use("/", createMetricsRouter(metrics.registry));
  return { app, metrics };
}

describe("GET /metrics", () => {
  it("returns 200 with prometheus text content-type", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("contains voice_sessions_active metric", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("voice_sessions_active");
  });

  it("contains voice_sessions_started_total metric", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("voice_sessions_started_total");
  });

  it("contains voice_dispatch_latency_ms histogram", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("voice_dispatch_latency_ms");
  });

  it("contains process_cpu_user_seconds_total (default metrics)", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });
});
