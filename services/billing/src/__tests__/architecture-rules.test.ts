/**
 * The architectural rules from CLAUDE.md, as executable checks.
 *
 * They are currently enforced by a reviewer reading a diff. That works until a
 * diff is large or a reviewer is tired, and the failure is silent: nothing
 * breaks, the boundary just stops being real - which is the same way the
 * provider abstraction and two guards in this work quietly stopped meaning
 * anything.
 *
 * These are cheap, and they fail on the change that breaks them rather than
 * months later when someone notices.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "../../../..");

function filesUnder(dir: string, ext = ".ts"): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist" && entry !== "__tests__") walk(full);
        continue;
      }
      if (entry.endsWith(ext)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Comments describe LLM usage all over the codebase; only calls matter. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The service inventory CLAUDE.md declares. */
const SERVICES = [
  "ai", "auth", "conversation", "chatbot", "analytics", "notifications",
  "webhook", "incoming-worker", "outgoing-worker", "voice-copilot", "billing",
];

/** Everything that is not the one service allowed to call an LLM. */
const NON_AI_SERVICES = SERVICES.filter((s) => s !== "ai");

describe("each service owns its own domain", () => {
  const BILLING_MODELS = [
    "pendingCheckout", "paymentAttempt", "paymentQuote", "billingExchangeRate",
    "tokenizationSession", "paymentContinuationLink", "billingProfile",
    "paymentMethod", "dunningState", "providerCustomer", "providerBillingEvent",
  ];

  it("no other service reads or writes billing's tables", () => {
    const offenders: string[] = [];
    for (const svc of SERVICES.filter((s) => s !== "billing")) {
      for (const file of filesUnder(join(REPO, "services", svc, "src"))) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const model of BILLING_MODELS) {
          if (new RegExp(`prisma\\.${model}\\b`).test(code)) {
            offenders.push(`${svc}: ${model} in ${file.replace(REPO + "/", "")}`);
          }
        }
      }
    }
    // Money state belongs to billing. Another service reading it directly is
    // how two systems end up disagreeing about what a customer owes.
    expect(offenders, `cross-service billing access:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("new LLM calls live only in services/ai", () => {
  // CLAUDE.md grandfathers exactly these two, and says they must not be
  // extended or copied.
  const GRANDFATHERED = [
    "services/auth/src/routes/onboarding.ts",
    "services/incoming-worker/src/services/knowledge-retrieval.service.ts",
  ];

  it("no service outside ai makes an LLM call", () => {
    const offenders: string[] = [];
    for (const svc of NON_AI_SERVICES) {
      for (const file of filesUnder(join(REPO, "services", svc, "src"))) {
        const rel = file.replace(REPO + "/", "");
        if (GRANDFATHERED.includes(rel)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        // An actual call or client construction, not the word appearing in prose.
        if (/new OpenAI\(|from ["']openai["']|require\(["']openai["']\)|chat\.completions\.create/.test(code)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `LLM calls outside services/ai:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the grandfathered files still exist, so the exemption stays honest", () => {
    // If one is deleted or renamed, the list above silently starts exempting
    // nothing - and a reviewer reading it would believe otherwise.
    for (const rel of GRANDFATHERED) {
      expect(() => readFileSync(join(REPO, rel), "utf8"), `${rel} is missing`).not.toThrow();
    }
  });
});

describe("the service inventory does not grow by accident", () => {
  it("has exactly the services CLAUDE.md lists", () => {
    const present = readdirSync(join(REPO, "services")).filter((d) =>
      statSync(join(REPO, "services", d)).isDirectory(),
    );
    // A new microservice is a decision to be taken deliberately, not something
    // that appears in a diff.
    expect(present.sort()).toEqual([...SERVICES].sort());
  });
});
