import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { nodeRequirement } from "../NodeInfoIcon";
import { NODE_REGISTRY, PROVIDER_CONNECTIONS } from "../node-registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");

describe("§6 node info uses ONE canonical metadata source", () => {
  const src = read("../NodeInfoIcon.tsx");
  it("derives the tooltip from the registry + node-i18n + derived ports (not a separate description)", () => {
    expect(src).toContain('from "./node-registry"');
    expect(src).toContain("getNodePorts");
    expect(src).toContain("nodeDesc");
    expect(src).toContain("nodeLabel");
  });

  it("§20 the tooltip works by hover AND keyboard focus, and is accessible", () => {
    expect(src).toContain("group-hover/info:opacity-100");
    expect(src).toContain("group-focus-within/info:opacity-100");
    expect(src).toContain('role="tooltip"');
    expect(src).toContain("aria-label");
  });

  it("does not require clicking the node (the icon stops click propagation)", () => {
    expect(src).toContain("e.stopPropagation()");
  });
});

describe("§6 port-type + tooltip strings are localized (business language, no enums)", () => {
  const enPorts = (en as any).aiStudio.portTypes;
  const hePorts = (he as any).aiStudio.portTypes;
  it("all port types have EN + HE labels", () => {
    for (const p of ["flow", "branch", "participant", "participant_event", "message", "any"]) {
      expect(enPorts[p], `en portType ${p}`).toBeTruthy();
      expect(hePorts[p], `he portType ${p}`).toBeTruthy();
    }
  });
  it("the voice add-participant limitation is stated in both languages", () => {
    expect((en as any).aiStudio.nodes.voice_add_participant.limitation).toBeTruthy();
    expect((he as any).aiStudio.nodes.voice_add_participant.limitation).toBeTruthy();
  });
  it("nodeInfo tooltip labels exist in EN + HE", () => {
    for (const k of ["about", "receives", "produces", "noInput", "noOutput"]) {
      expect((en as any).aiStudio.nodeInfo[k], `en nodeInfo.${k}`).toBeTruthy();
      expect((he as any).aiStudio.nodeInfo[k], `he nodeInfo.${k}`).toBeTruthy();
    }
  });
});

describe("§4 integration-dependency: node stays visible but states its requirement", () => {
  it("§17 voice nodes require a voice channel and point at the canonical Connect location", () => {
    const req = nodeRequirement("voice_add_participant");
    expect(req).not.toBeNull();
    expect(req!.connectHref).toBe("/settings/channels/twilio"); // reuse the Settings connection, no duplicate
    expect((en as any).aiStudio.nodeReq.voiceChannel).toBeTruthy();
    expect((he as any).aiStudio.nodeReq.voiceChannel).toBeTruthy();
  });
  it("a voice trigger subtype also carries the requirement", () => {
    expect(nodeRequirement("voice_trigger:call.incoming")).not.toBeNull();
  });
  it("ordinary nodes carry no external requirement", () => {
    expect(nodeRequirement("send_message_text")).toBeNull();
    expect(nodeRequirement("condition_group")).toBeNull();
  });

  it("§4 the requirement is METADATA-DRIVEN: it comes from the node's `requires` key, not a type-name branch", () => {
    // Every node that declares `requires` resolves via PROVIDER_CONNECTIONS, and
    // every node that does not returns null - no special-casing of type names.
    for (const [type, entry] of Object.entries(NODE_REGISTRY)) {
      const req = nodeRequirement(type);
      if (entry.requires) {
        expect(req, `${type} declares requires="${entry.requires}"`).not.toBeNull();
        expect(req!.connectHref).toBe(PROVIDER_CONNECTIONS[entry.requires].connectHref);
      } else {
        expect(req, `${type} declares no provider`).toBeNull();
      }
    }
  });

  it("§4 is PROVIDER-GENERIC: a future Shopify/CRM/calendar node inherits the behavior with no code branch", () => {
    // The mechanism already resolves providers that ship no node yet, purely
    // from the data table - proving no provider-specific rewrite is needed.
    for (const p of ["voice", "shopify", "crm", "calendar"] as const) {
      const conn = PROVIDER_CONNECTIONS[p];
      expect(conn, `PROVIDER_CONNECTIONS.${p}`).toBeTruthy();
      expect((en as any).aiStudio.nodeReq[conn.capabilityKey.split(".").pop()!], `en ${conn.capabilityKey}`).toBeTruthy();
      expect((he as any).aiStudio.nodeReq[conn.capabilityKey.split(".").pop()!], `he ${conn.capabilityKey}`).toBeTruthy();
    }
    // nodeRequirement contains no per-provider / type-prefix branching.
    const src = read("../NodeInfoIcon.tsx");
    expect(src).not.toContain('startsWith("voice_")');
    expect(src).toContain("NODE_REGISTRY[type]?.requires");
  });
});
