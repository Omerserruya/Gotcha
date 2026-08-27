/**
 * A tool that cannot run must never be offered to a model.
 *
 * The failure this exists to prevent, in full: `shopify.edit_order` was added
 * in June and never implemented - its entire execution branch was a `throw`.
 * `exchange_order_item` replaced it in August. Both stayed in the catalogue as
 * equals, so an agent created on 23 August was granted the dead one and not its
 * replacement. On 26 August a customer asked to change the colour of an
 * unshipped order; the model reached for the only tool it had, was refused at
 * dispatch, and the conversation was escalated to a human for a swap the store
 * could have made in one call.
 *
 * The `unsupported` flag existed the whole time. It was only ever checked at
 * DISPATCH - after the model had chosen the tool and shaped a promise around
 * it. These tests hold the invariant at both ends, for every adapter, so the
 * next provider that declares a tool it cannot implement cannot repeat it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import "../services/connectors/index";
import {
  listAdapters,
  toolCannotExecute,
  toolBlockedByMissingScopes,
  type ToolDefinition,
} from "../services/connectors/integration-framework";

const CONNECTORS = join(__dirname, "../services/connectors");
const SRC = join(__dirname, "..");

const allTools: Array<{ adapter: string; def: ToolDefinition }> = listAdapters().flatMap((a: any) =>
  (a.tools() as ToolDefinition[]).map((def) => ({ adapter: a.slug ?? "?", def })),
);

describe("the predicate", () => {
  it("recognises a declared-unsupported tool", () => {
    expect(toolCannotExecute({ name: "x", unsupported: "no" } as any)).toBe(true);
  });

  it("does not trip on an empty string, null or a normal tool", () => {
    expect(toolCannotExecute({ name: "x", unsupported: "" } as any)).toBe(false);
    expect(toolCannotExecute({ name: "x" } as any)).toBe(false);
    expect(toolCannotExecute(null)).toBe(false);
    expect(toolCannotExecute(undefined)).toBe(false);
  });

  it("is independent of the missing-scope gate", () => {
    // Two different reasons a tool cannot run. Neither implies the other, and
    // checking only one is how edit_order stayed on the surface.
    const def = { name: "x", unsupported: "no", requiredScopes: ["read_x"] } as any;
    expect(toolBlockedByMissingScopes(def, [])).toBe(false);
    expect(toolCannotExecute(def)).toBe(true);
  });
});

describe("the tool surface drops what cannot run", () => {
  it("checks toolCannotExecute where it builds the model's tool list", () => {
    // A source guard: the surface is a long loop in ai-bot.service and the
    // check is one `continue`. Deleting it would be silent everywhere else.
    const surface = readFileSync(join(SRC, "services/ai-bot.service.ts"), "utf8");
    expect(surface).toContain("toolCannotExecute(def)");
    const at = surface.indexOf("toolCannotExecute(def)");
    expect(surface.slice(at, at + 200)).toContain("continue");
  });

  it("still checks it at dispatch, as a backstop", () => {
    const framework = readFileSync(join(CONNECTORS, "integration-framework.ts"), "utf8");
    expect(framework).toContain("if (toolCannotExecute(def))");
  });
});

describe("every adapter, every tool", () => {
  it("has adapters loaded, or the sweep below proves nothing", () => {
    expect(allTools.length).toBeGreaterThan(50);
  });

  it("gives a reason whenever it declares a tool unsupported", () => {
    // The string is shown to the model and shapes what it tells the customer,
    // so `unsupported: true` or an empty note is not enough.
    for (const { adapter, def } of allTools) {
      if (def.unsupported === undefined) continue;
      expect(typeof def.unsupported, `${adapter}.${def.name}`).toBe("string");
      expect((def.unsupported as string).length, `${adapter}.${def.name}`).toBeGreaterThan(10);
    }
  });

  it("never declares an ACTION unsupported - delete it instead", () => {
    // A READ that degrades is survivable: the model asks, gets nothing, moves
    // on. An ACTION that degrades is a promise to a customer that cannot be
    // kept, and it is grantable to an agent as if it worked. If it cannot be
    // implemented, it should not exist - which is what happened to edit_order.
    const offenders = allTools
      .filter(({ def }) => toolCannotExecute(def) && def.category === "ACTION")
      .map(({ adapter, def }) => `${adapter}: ${def.name}`);
    expect(offenders).toEqual([]);
  });

  it("does not still declare the deleted edit_order", () => {
    expect(allTools.find(({ def }) => def.name === "shopify.edit_order")).toBeUndefined();
  });
});

describe("declarations match the code", () => {
  /**
   * Every `unsupported_rest` throw must belong to a tool that DECLARED itself
   * unsupported. A handler that throws without the declaration is invisible to
   * both gates - it would be surfaced, chosen, approved, and only fail when a
   * customer was already waiting on it.
   */
  const adapterFiles = readdirSync(CONNECTORS).filter((f) => f.endsWith(".adapter.ts"));

  it.each(adapterFiles)("%s declares every tool whose handler refuses outright", (file) => {
    const src = readFileSync(join(CONNECTORS, file), "utf8");
    const slug = file.replace(".adapter.ts", "");

    // `case "x":` immediately followed by a throw of unsupported_*.
    const throwing = new Set<string>();
    const re = /case\s+"([a-z0-9_]+)"\s*:\s*(?:\/\/[^\n]*\n\s*)*throw new Error\(\s*"unsupported[_a-z]*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) throwing.add(m[1]);

    const declared = new Set(
      allTools
        .filter(({ def }) => toolCannotExecute(def) && def.name.startsWith(`${slug}.`))
        .map(({ def }) => def.name.slice(slug.length + 1)),
    );

    const undeclared = [...throwing].filter((name) => !declared.has(name));
    expect(undeclared, `${file}: handlers throw unsupported without declaring it`).toEqual([]);
  });
});
