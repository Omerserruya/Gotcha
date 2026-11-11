/**
 * No per-employee model (Omer, 2026-11-11): every AI employee runs on the
 * platform model (OPENAI_DEFAULT_MODEL), whatever ai_agents.model holds.
 * Found on dev: every employee held "gpt-5-mini", so an env swap to gpt-6-luna
 * never reached the reply, regen or rewrite passes.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("openai", () => ({ default: class { chat = { completions: { create: async () => ({}) } }; embeddings = { create: async () => ({ data: [] }) }; } }));

import { initAIService, getDefaultModel } from "../services/ai.service";
import { resolveAgentModel } from "../lib/agent-model";
import { aiAgentCreationDefaults } from "../services/ai-agent-defaults";
import { buildConfigFromAIAgent } from "../services/ai-assist.service";

beforeAll(() => { initAIService({ apiKey: "test", defaultModel: "gpt-6-luna" } as any); });

const base: any = { id: "a1", name: "Noa", status: "ACTIVE", provider: "openai", temperature: 0.7, maxTokens: 1024 };

describe("an employee's model is always the platform model", () => {
  it("whatever the row holds: a snapshot, an old default, another model, 'default', or nothing", () => {
    expect(getDefaultModel()).toBe("gpt-6-luna");
    for (const stored of ["gpt-5-mini", "gpt-4o-mini", "gpt-5", "o3-mini", "default", "", null, undefined]) {
      expect(resolveAgentModel(stored as any)).toBe("gpt-6-luna");
    }
  });

  it("the employee config every reply path reads (reply, regen, rewrite, cards, escalation, recovery) carries it", () => {
    for (const stored of ["gpt-5-mini", "gpt-5", "anything"]) {
      expect(buildConfigFromAIAgent({ ...base, model: stored } as any).model).toBe("gpt-6-luna");
    }
  });

  it('a new employee is written as "default"', () => {
    expect(aiAgentCreationDefaults().model).toBe("default");
  });

  it("the API no longer takes a model: create writes \"default\", PUT drops it, departments drops it", () => {
    const routes = fs.readFileSync(path.resolve(__dirname, "../routes/ai-agents.ts"), "utf8");
    const editable = /const AGENT_EDITABLE_FIELDS = \[([\s\S]*?)\] as const;/.exec(routes)?.[1] ?? "";
    expect(editable).not.toMatch(/"model"/);
    expect(routes).toMatch(/model: "default",/);
    expect(routes).not.toMatch(/model: model \|\|/);
    const departments = fs.readFileSync(path.resolve(__dirname, "../../../auth/src/routes/departments.ts"), "utf8");
    expect(departments).not.toMatch(/data\.model\s*=/);
  });

  it("every reply-path read goes through the one resolver", () => {
    const bot = fs.readFileSync(path.resolve(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(bot).not.toMatch(/config\.model \|\|/);
    expect(bot.match(/resolveAgentModel\(config\.model\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    const provider = fs.readFileSync(path.resolve(__dirname, "../services/openai.provider.ts"), "utf8");
    expect(provider).not.toMatch(/config\?\.model \|\|/);
  });
});
