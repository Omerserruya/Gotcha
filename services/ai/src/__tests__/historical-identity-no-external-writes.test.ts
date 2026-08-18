import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Historical import must never create a customer in Shopify, a CRM, or any
 * other external system of record.
 *
 * ── Why this is a structural test rather than a behavioural one ──
 *
 * A mocked test can only prove that the code did not call `customerCreate` on
 * the path the test happened to take. The guarantee that matters is stronger
 * and permanent: there is NO path from this pipeline to a creation call at all,
 * and there never will be, because the facade it uses does not expose one.
 *
 * The damage this prevents is not hypothetical. A business imports 180 days of
 * WhatsApp history, and the next morning their Shopify admin has twelve hundred
 * customers who never bought anything. Their segments move, their marketing
 * lists move, their reporting moves, and on a per-customer plan their bill
 * moves. None of it is reversible with a button.
 *
 * ── The three layers, checked here ──
 *
 *  1. `SourceOfTruthProvider` - the interface the pipeline uses - has no create
 *     method. This is the load-bearing one: an edit that tried would not
 *     compile.
 *  2. No file in the pipeline reaches past the facade to the raw adapter.
 *  3. No file in the pipeline names any known creation call.
 */

const PIPELINE_DIR = join(__dirname, "..", "services", "historical-intelligence");
const SOURCE_OF_TRUTH = join(__dirname, "..", "services", "connectors", "source-of-truth.ts");

function pipelineFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(PIPELINE_DIR);
  return out;
}

/** Every way this repository creates a record in an external system. */
const EXTERNAL_CREATION_CALLS = [
  "customerCreate",
  "createLead",
  "createContact",
  "createRecord",
  "integration_create_lead",
  "integration_create_contact",
  "customerUpdate",
  "createCustomer",
];

describe("the facade the pipeline uses cannot create anything", () => {
  const src = readFileSync(SOURCE_OF_TRUTH, "utf8");

  it("SourceOfTruthProvider exposes no creation method", () => {
    const iface = src.match(/export interface SourceOfTruthProvider \{([\s\S]*?)\n\}/);
    expect(iface, "SourceOfTruthProvider interface not found").toBeTruthy();
    const body = iface![1];

    for (const call of EXTERNAL_CREATION_CALLS) {
      expect(body, `SourceOfTruthProvider must not expose ${call}`).not.toContain(call);
    }
  });

  it("its only customer lookup is read-only by name and by shape", () => {
    const iface = src.match(/export interface SourceOfTruthProvider \{([\s\S]*?)\n\}/)![1];
    expect(iface).toContain("identifyCustomer");
    // A lookup takes identifiers and nothing else. A creation call would need
    // a payload of fields, and that is the shape difference worth pinning.
    expect(iface).toMatch(
      /identifyCustomer\(query: \{ phone\?: string; email\?: string; external_id\?: string \}\)/,
    );
  });
});

describe("the pipeline never reaches past the facade", () => {
  const files = pipelineFiles();

  it("has files to check, so a rename cannot silently empty this test", () => {
    // Without this, moving the directory would turn every assertion below into
    // a vacuous pass over an empty list.
    expect(files.length).toBeGreaterThan(4);
  });

  it.each(EXTERNAL_CREATION_CALLS)("never names %s", (call) => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Comments are allowed to discuss these calls - explaining what must not
      // happen is the point of several of them - so only real code counts.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\n");
      expect(code, `${file} must not call ${call}`).not.toContain(call);
    }
  });

  it("never imports the raw CRM adapter or its resolver", () => {
    // `getCrmAdapter` returns the unguarded adapter, which DOES have createLead.
    // The facade exists precisely so this layer never holds one.
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const imports = src
        .split("\n")
        .filter((l) => l.trim().startsWith("import"))
        .join("\n");
      expect(imports, `${file} must not import the raw adapter`).not.toContain("crm-adapter-resolver");
      expect(imports, `${file} must not import the raw adapter`).not.toContain("crm-adapter.impl");
      expect(imports, `${file} must not import getCrmAdapter`).not.toContain("getCrmAdapter");
    }
  });

  it("reaches the source of truth only through getSourceOfTruth", () => {
    const identity = readFileSync(join(PIPELINE_DIR, "identity.stage.ts"), "utf8");
    expect(identity).toContain("getSourceOfTruth");
    expect(identity).toContain("identifyCustomer");
  });
});

describe("GOTCHA's own contacts are linked, not manufactured", () => {
  const identity = readFileSync(join(PIPELINE_DIR, "identity.stage.ts"), "utf8");

  it("never creates a Contact row", () => {
    // A Contact appears in contact lists, segments and broadcast audiences.
    // Manufacturing twelve hundred of them out of history would change the
    // customer's product without being asked, and the live path creates one
    // anyway the moment that person writes again.
    const code = identity
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("contact.create");
    expect(code).not.toContain("contact.upsert");
  });

  it("only ever updates a contact that already exists", () => {
    expect(identity).toContain("prisma.contact.updateMany");
  });

  it("stamps provenance on anything it does write", () => {
    expect(identity).toContain("historical_whatsapp_import");
  });

  it("does not mark a discovered email as verified", () => {
    // The customer typed it into a chat and nobody confirmed it. Marking it
    // verified would let it be used for things that require a verified address.
    const code = identity.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("emailVerified: true");
  });
});
