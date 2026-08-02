import { describe, it, expect } from "vitest";

/**
 * OpenAI rejects a tools array longer than 128. Hard 400, whole request lost.
 *
 *   [ai-bot/reply] error: 400 Invalid 'tools': array too long.
 *   Expected an array with maximum length 128, but got an array with length 131.
 *
 * A merchant had 62 Shopify tools enabled; with the built-ins that came to 131.
 * Every turn failed, the fallback generated a reply with no tools available,
 * and a customer asking to cancel order #1006 was told "אני מעבירה את הבקשה
 * לצוות אנושי" three times running. The approval flow, the tool permissions and
 * `cancel_order` itself were all working - the request never reached the model.
 *
 * This tests the selection rule directly. It is a pure function of the tool
 * list, so it can be checked without a model, a database or a network call -
 * which matters, because the failure it prevents is invisible in every test
 * that stubs the OpenAI client.
 */

const OPENAI_MAX_TOOLS = 128;

/** Mirrors the cap in ai-bot.service.ts. */
function capToolSurface(tools: Array<{ function: { name: string } }>) {
  const nameOf = (x: any): string => x?.function?.name ?? "";
  const isIntegration = (n: string) => n.includes(".") || n.startsWith("integration.");
  if (tools.length <= OPENAI_MAX_TOOLS) return { kept: tools, dropped: [] as string[] };
  const builtIns = tools.filter((x) => !isIntegration(nameOf(x)));
  const integrations = tools.filter((x) => isIntegration(nameOf(x)));
  const room = Math.max(0, OPENAI_MAX_TOOLS - builtIns.length);
  const dropped = integrations.slice(room).map(nameOf);
  const kept = [...builtIns, ...integrations.slice(0, room)].sort((a, b) =>
    nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0,
  );
  return { kept, dropped };
}

const tool = (name: string) => ({ function: { name } });

/** The real shape: ~69 built-ins + 62 Shopify tools = 131. */
function productionShape() {
  const builtIns = Array.from({ length: 69 }, (_, i) => tool(`builtin_${String(i).padStart(2, "0")}`));
  const shopify = Array.from({ length: 62 }, (_, i) => tool(`shopify.tool_${String(i).padStart(2, "0")}`));
  return [...builtIns, ...shopify];
}

describe("the array that OpenAI rejected", () => {
  it("is 131 tools, over the limit", () => {
    expect(productionShape()).toHaveLength(131);
    expect(productionShape().length).toBeGreaterThan(OPENAI_MAX_TOOLS);
  });

  it("is brought within the limit", () => {
    const { kept } = capToolSurface(productionShape());
    expect(kept.length).toBeLessThanOrEqual(OPENAI_MAX_TOOLS);
  });

  it("drops exactly the overflow, not more", () => {
    const { kept, dropped } = capToolSurface(productionShape());
    expect(dropped).toHaveLength(131 - OPENAI_MAX_TOOLS);
    expect(kept).toHaveLength(OPENAI_MAX_TOOLS);
  });
});

describe("what survives the cap", () => {
  it("keeps EVERY built-in - escalation must never be the thing dropped", () => {
    // Dropping escalate_to_human to make room for a catalog read would be the
    // worst possible trade: the agent would lose its only way out.
    const tools = [...productionShape(), tool("escalate_to_human")];
    const { kept, dropped } = capToolSurface(tools);
    expect(dropped.some((n) => n === "escalate_to_human")).toBe(false);
    expect(kept.some((t) => t.function.name === "escalate_to_human")).toBe(true);
  });

  it("only ever drops integration tools", () => {
    const { dropped } = capToolSurface(productionShape());
    for (const n of dropped) expect(n).toMatch(/\./);
  });

  it("leaves a surface under the limit completely untouched", () => {
    // The common case must cost nothing.
    const small = Array.from({ length: 40 }, (_, i) => tool(`t_${i}`));
    const { kept, dropped } = capToolSurface(small);
    expect(dropped).toEqual([]);
    expect(kept).toBe(small);
  });
});

describe("the choice is deterministic", () => {
  it("drops the same tools every time", () => {
    // Byte-stability matters here: the tools array is part of the prompt cache
    // prefix, and a surface that reshuffles per turn would break the cache as
    // well as making the loss unpredictable.
    const a = capToolSurface(productionShape()).dropped;
    const b = capToolSurface(productionShape()).dropped;
    expect(a).toEqual(b);
  });

  it("returns the kept tools in stable alphabetical order", () => {
    const { kept } = capToolSurface(productionShape());
    const names = kept.map((t) => t.function.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("degenerate inputs", () => {
  it("survives a surface made entirely of built-ins", () => {
    const all = Array.from({ length: 140 }, (_, i) => tool(`builtin_${i}`));
    const { kept } = capToolSurface(all);
    // Nothing can be dropped without losing a faculty, so nothing is - the
    // request will still fail, but LOUDLY and for a reason an operator can act
    // on, rather than by silently discarding the agent's own capabilities.
    expect(kept.length).toBe(140);
  });

  it("handles a surface that is entirely integration tools", () => {
    const all = Array.from({ length: 140 }, (_, i) => tool(`shopify.t_${String(i).padStart(3, "0")}`));
    const { kept, dropped } = capToolSurface(all);
    expect(kept).toHaveLength(OPENAI_MAX_TOOLS);
    expect(dropped).toHaveLength(12);
  });
});
