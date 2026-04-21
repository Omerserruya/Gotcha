import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSecret, requireSecret, setSecretProvider, resetSecretProvider } from "../index";
import type { SecretProvider } from "../index";

describe("secrets", () => {
  beforeEach(() => {
    resetSecretProvider();
  });

  afterEach(() => {
    // Clean up env vars
    delete process.env["TENANT_ACME_MY_KEY"];
    delete process.env["MY_KEY"];
    resetSecretProvider();
  });

  it("returns tenant-prefixed env var when set", async () => {
    process.env["TENANT_ACME_MY_KEY"] = "tenant-value";
    const result = await getSecret("acme", "my_key");
    expect(result).toBe("tenant-value");
  });

  it("falls back to global env when tenant-scoped var is missing", async () => {
    process.env["MY_KEY"] = "global-value";
    const result = await getSecret("acme", "my_key");
    expect(result).toBe("global-value");
  });

  it("returns undefined when both tenant-scoped and global vars are missing", async () => {
    const result = await getSecret("acme", "my_key");
    expect(result).toBeUndefined();
  });

  it("requireSecret returns value when secret exists", async () => {
    process.env["MY_KEY"] = "found-value";
    const result = await requireSecret("acme", "my_key");
    expect(result).toBe("found-value");
  });

  it("requireSecret throws when secret is missing", async () => {
    await expect(requireSecret("acme", "my_key")).rejects.toThrow(
      "Missing secret my_key for tenant acme"
    );
  });

  it("setSecretProvider swaps provider and resetSecretProvider restores default", async () => {
    const mockProvider: SecretProvider = {
      async get(_tenantId: string, key: string): Promise<string | undefined> {
        if (key === "TOKEN") return "mock-token";
        return undefined;
      },
    };

    setSecretProvider(mockProvider);
    const result = await getSecret("any-tenant", "TOKEN");
    expect(result).toBe("mock-token");

    // After reset, falls back to env provider (no env set → undefined)
    resetSecretProvider();
    const afterReset = await getSecret("any-tenant", "TOKEN");
    expect(afterReset).toBeUndefined();
  });

  it("EnvSecretProvider throws on invalid tenantId (contains . or space)", async () => {
    await expect(getSecret("acme.corp", "MY_KEY")).rejects.toThrow(
      "EnvSecretProvider: invalid tenantId acme.corp"
    );
    await expect(getSecret("acme corp", "MY_KEY")).rejects.toThrow(
      "EnvSecretProvider: invalid tenantId acme corp"
    );
  });
});
