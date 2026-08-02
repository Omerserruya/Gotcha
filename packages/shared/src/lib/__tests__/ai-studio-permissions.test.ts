import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "../permission-catalog";

const REPO = join(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const keys = new Set(PERMISSIONS.map((p) => p.key));

describe("§10 AI Studio permission catalog", () => {
  it("defines the new AI Studio permission keys under the existing `ai` domain", () => {
    for (const key of ["ai:workflows:publish", "ai:tools:read", "ai:tools:manage", "ai:tools:assign"]) {
      expect(keys, key).toContain(key);
      const def = PERMISSIONS.find((p) => p.key === key)!;
      expect(def.domain).toBe("ai");
      expect(def.kind).toBe("configuration");
    }
  });

  it("reuses existing keys for the concepts that already have them (no competing ai-studio: domain)", () => {
    for (const key of ["ai:workflows:update", "ai:knowledge:write", "ai:employees:create", "approvals:policies:manage"]) {
      expect(keys).toContain(key);
    }
    // No parallel `ai-studio:*` domain was introduced.
    expect([...keys].some((k) => k.startsWith("ai-studio:"))).toBe(false);
  });
});

describe("§10 AI Studio backend routes are membership-permission gated (no direct role checks)", () => {
  const files: Record<string, string> = {
    chatbot: read("services/chatbot/src/routes/chatbot.ts"),
    knowledge: read("services/ai/src/routes/knowledge.ts"),
    aiAgents: read("services/ai/src/routes/ai-agents.ts"),
    toolPerms: read("services/ai/src/routes/tool-permissions.ts"),
  };

  it("no AI Studio route file still uses requireRole(\"ADMIN\")", () => {
    for (const [name, src] of Object.entries(files)) {
      expect(src, `${name} must not requireRole("ADMIN")`).not.toContain('requireRole("ADMIN")');
    }
  });

  it("workflow save uses ai:workflows:update and publish uses ai:workflows:publish (anti-lockout ADMIN fallback)", () => {
    expect(files.chatbot).toContain('requirePermissionOrRole("ai:workflows:update", "ADMIN")');
    expect(files.chatbot).toContain('requirePermissionOrRole("ai:workflows:publish", "ADMIN")');
  });

  it("knowledge reads floor at ai:knowledge:read, mutations require ai:knowledge:write", () => {
    expect(files.knowledge).toContain('requirePermissionOrRole("ai:knowledge:read", "ADMIN")');
    expect(files.knowledge).toContain('requirePermissionOrRole("ai:knowledge:write", "ADMIN")');
  });

  it("tool config uses ai:tools:manage; tool assignment uses ai:tools:assign", () => {
    expect(files.toolPerms).toContain('requirePermissionOrRole("ai:tools:manage", "ADMIN")');
    expect(files.aiAgents).toContain('requirePermissionOrRole("ai:tools:assign", "ADMIN")');
  });

  it("employee reads/writes use ai:employees:* keys", () => {
    expect(files.aiAgents).toContain('requirePermissionOrRole("ai:employees:read", "ADMIN")');
    expect(files.aiAgents).toContain('requirePermissionOrRole("ai:employees:update", "ADMIN")');
    expect(files.aiAgents).toContain('requirePermissionOrRole("ai:employees:delete", "ADMIN")');
  });

  it("tenant isolation preserved: converted routes still scope queries by tenantId", () => {
    expect(files.chatbot).toContain("tenantId: req.tenantId!");
    expect(files.knowledge).toContain("req.tenantId");
  });
});
