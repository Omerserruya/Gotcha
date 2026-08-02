import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { encryptCredentials, decryptCredentials } from "../encryption";

/**
 * The seed must never write a credential in plaintext.
 *
 * It used to. Every runtime writer calls `encryptCredentials()`, but
 * `prisma/seed.ts` wrote raw JSON objects - and several of those read a REAL
 * token out of the environment (WHATSAPP_ACCESS_TOKEN,
 * MESSENGER_ACCESS_TOKEN, ...). Seeding a machine that had them set wrote live
 * provider credentials into the database unencrypted.
 *
 * Nothing caught it because every reader carries a
 * `typeof creds === "string" ? decrypt(creds) : creds` shim for exactly this
 * shape. The compatibility that kept the seed working is what kept the
 * plaintext invisible - which is why this is a static check on the source
 * rather than a behavioural one. A behavioural test would pass either way.
 */

const SEED = join(__dirname, "..", "..", "..", "prisma", "seed.ts");

describe("prisma/seed.ts never writes a plaintext credential", () => {
  const src = readFileSync(SEED, "utf-8");

  it("has no raw `credentials: {` object literal", () => {
    // The exact shape that caused this. Every credential write must go through
    // the `creds()` helper, which encrypts.
    const matches = src.match(/credentials:\s*\{/g) ?? [];
    expect(
      matches,
      "a raw object literal here is stored unencrypted; wrap it in creds()",
    ).toHaveLength(0);
  });

  it("routes every credential write through the encrypting helper", () => {
    // Strip string literals first - the seed also logs "Login credentials:" to
    // the console, which is not a database write.
    const code = src
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const writes = (code.match(/credentials:/g) ?? []).length;
    const wrapped = (code.match(/credentials:\s*creds\(/g) ?? []).length;
    expect(writes, "expected the seed to still write credentials").toBeGreaterThan(0);
    expect(wrapped, `${writes} credential writes, ${wrapped} encrypted`).toBe(writes);
  });

  it("imports the real encryption helper, not a local stub", () => {
    expect(src).toMatch(/import\s*\{[^}]*encryptCredentials[^}]*\}\s*from\s*["'].*encryption["']/);
  });
});

describe("the format the readers expect", () => {
  const KEY = "CHANNEL_ENCRYPTION_KEY";
  const had = process.env[KEY];

  it("encrypts to a STRING, not an object", () => {
    // This is the second half of the bug: a seeded row was a JSON object where
    // the runtime writes a base64 string, so seeded integrations were in a
    // format `decryptCredentials` cannot read at all.
    process.env[KEY] = "test-key-for-shape-assertions";
    try {
      const out = encryptCredentials({ accessToken: "abc", webhookSecret: "def" });
      expect(typeof out).toBe("string");
      expect(out).not.toContain("accessToken");
      expect(decryptCredentials(out)).toEqual({ accessToken: "abc", webhookSecret: "def" });
    } finally {
      if (had === undefined) delete process.env[KEY];
      else process.env[KEY] = had;
    }
  });

  it("refuses to encrypt with no key rather than falling back to a default", () => {
    // A silent fallback key would be worse than plaintext: it would LOOK
    // encrypted while being decryptable by anyone with the source.
    const saved = process.env[KEY];
    delete process.env[KEY];
    try {
      expect(() => encryptCredentials({ accessToken: "abc" })).toThrow(/CHANNEL_ENCRYPTION_KEY/);
    } finally {
      if (saved !== undefined) process.env[KEY] = saved;
    }
  });
});
