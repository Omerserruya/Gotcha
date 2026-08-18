/**
 * Which error codes actually have an emitter, proven by scanning the source.
 *
 * An alert rule that filters on a code nothing emits is not an alert. It is a
 * dashboard entry that will stay green through the exact incident it was
 * written for. This test exists so that "documented" can never be mistaken for
 * "operational" - the classification is derived from the code, not from a
 * document someone updated by hand.
 *
 * It deliberately does NOT fail on uncovered codes. Some are legitimately
 * pending (blocked by the protected P0 execution routes). It fails when the
 * recorded expectation and reality diverge, so adding an emitter without
 * updating the status, or losing one, both break the build.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, type ErrorCode } from "../observability/error-codes";

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try { if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir; } catch { /* walk */ }
    }
    dir = path.dirname(dir);
  }
  throw new Error("workspace root not found");
}
const ROOT = repoRoot();

/** Every production .ts file (tests excluded - a test is not an emitter). */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__tests__" || e.name === "dist") continue;
        walk(f);
        continue;
      }
      if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue;
      out.push(f);
    }
  };
  walk(path.join(ROOT, "services"));
  walk(path.join(ROOT, "packages"));
  return out;
}

/** Codes referenced as ERROR_CODES.<code> in production code. */
function emittedCodes(): Map<ErrorCode, string[]> {
  const found = new Map<ErrorCode, string[]>();
  const all = Object.values(ERROR_CODES) as ErrorCode[];
  for (const file of productionSources()) {
    const src = fs.readFileSync(file, "utf8");
    // The taxonomy file itself defines them; it does not emit them.
    if (file.endsWith(path.join("observability", "error-codes.ts"))) continue;
    for (const code of all) {
      if (new RegExp(`ERROR_CODES\\.${code}\\b`).test(src)) {
        found.set(code, [...(found.get(code) ?? []), path.relative(ROOT, file)]);
      }
    }
  }
  return found;
}

/**
 * The recorded state of the world. Every code must appear in exactly one list,
 * and the lists must match what the scan finds.
 */
const EXPECTED_EMITTED: ErrorCode[] = [
  "ai_provider_failure", "ai_timeout", "ai_rate_limit", "ai_invalid_output",
  "hitl_request_creation_failed", "hitl_notification_failed",
  "hitl_callback_invalid", "hitl_expired", "hitl_already_consumed",
  "integration_oauth_failed", "integration_token_refresh_failed",
  "integration_credentials_invalid", "integration_provisioning_failed",
  "integration_disconnect_cleanup_failed",
  "webhook_signature_invalid", "webhook_verification_failed", "webhook_processing_failed",
  // Emitted from the boot probe in incoming-worker and conversation, and from
  // the media resolver when a write is refused rather than a download.
  "media_storage_unwritable",
  "payment_callback_failed", "subscription_update_failed", "entitlement_creation_failed",
  "voice_provisioning_failed", "voice_number_activation_failed",
  "voice_twiml_failed", "voice_media_stream_failed", "voice_transcription_failed",
  "authorization_invariant_broken", "cross_tenant_exposure",
  "irreversible_duplicate_execution",
];

/** Blocked by the protected P0 execution routes - see the PR description. */
const BLOCKED_BY_P0_ROUTES: ErrorCode[] = [
  "action_execution_failed", "action_provider_failed",
  "action_persistence_failed", "action_notification_failed",
  "hitl_execution_failed", "hitl_payload_mismatch",
];

/**
 * No emitter, and not blocked. Empty is the goal state: every code either
 * emits or is blocked by the protected P0 routes.
 */
const DOCUMENTED_ONLY: ErrorCode[] = [];

describe("emitter coverage", () => {
  const emitted = emittedCodes();
  const allCodes = Object.values(ERROR_CODES) as ErrorCode[];

  it("classifies every code exactly once", () => {
    const listed = [...EXPECTED_EMITTED, ...BLOCKED_BY_P0_ROUTES, ...DOCUMENTED_ONLY];
    const dupes = listed.filter((c, i) => listed.indexOf(c) !== i);
    expect(dupes, "a code appears in more than one status list").toEqual([]);
    expect([...listed].sort(), "every code must have a recorded status").toEqual([...allCodes].sort());
  });

  it("every code recorded as EMITTED has a real emitter in production code", () => {
    const missing = EXPECTED_EMITTED.filter((c) => !emitted.has(c)).sort();
    expect(missing, "recorded as emitted but nothing references them").toEqual([]);
  });

  /**
   * The direction that matters most: it stops a future change from quietly
   * adding an emitter and leaving the alert documentation claiming otherwise -
   * or, worse, deleting one and leaving the alert looking live.
   */
  it("no code emits without being recorded as EMITTED", () => {
    const unexpected = [...emitted.keys()]
      .filter((c) => !EXPECTED_EMITTED.includes(c))
      .map((c) => `${c} (in ${emitted.get(c)!.join(", ")})`)
      .sort();
    expect(unexpected, "these now emit - move them into EXPECTED_EMITTED").toEqual([]);
  });

  it("reports the coverage split", () => {
    const total = allCodes.length;
    expect(EXPECTED_EMITTED.length + BLOCKED_BY_P0_ROUTES.length + DOCUMENTED_ONLY.length).toBe(total);
    // Visible in test output so the split is never a guess.
    console.log(
      `\n  error-code coverage: ${EXPECTED_EMITTED.length}/${total} emitted, ` +
      `${BLOCKED_BY_P0_ROUTES.length} blocked by P0 routes, ${DOCUMENTED_ONLY.length} documented only\n`,
    );
  });
});

describe("protected routes were not instrumented", () => {
  /**
   * A hard check rather than a promise. The two deferred P0 execution routes
   * must contain no emitter call, and this fails if one ever appears.
   */
  it("ai-assist.ts contains no operational failure emitter", () => {
    const f = path.join(ROOT, "services", "ai", "src", "routes", "ai-assist.ts");
    const src = fs.readFileSync(f, "utf8");
    expect(src).not.toContain("reportOperationalFailure");
    expect(src).not.toContain("ERROR_CODES.");
  });
});
