/**
 * Session registry + hash invariant tests.
 *
 * These tests assert the contract that makes prefix caching work:
 *   - opening a session twice with the same sessionId returns the same
 *     frozen object (no rebuild)
 *   - the SYSTEM_CORE bytes are stable across opens of equivalent inputs
 *   - a CONTENT change in the worker invalidates the fingerprint
 *   - drift triggers an exception in non-production envs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../skills"; // register system skills
import {
  getOrCreateSession,
  releaseSession,
  __clearRegistryForTests,
} from "../session-registry";
import {
  __clearSeenForTests,
  fingerprintPrefix,
  recordPrefixFingerprint,
  assertPrefixStability,
} from "../observability/prompt-hash";
import type { AIWorkerConfig, AIWorkerSessionProfile } from "@chatcenter/shared";

function makeWorker(overrides: Partial<AIWorkerConfig> = {}): AIWorkerConfig {
  return {
    id: "worker-1",
    tenantId: "tenant-1",
    identity: { name: "Sami", persona: "friendly", language: "en" },
    mode: "autonomous",
    skillIds: ["sales", "tool_usage_policy"],
    funnelId: null,
    guardrails: {
      blockedTopics: [],
      escalationKeywords: [],
      refundRequiresApproval: true,
      customRules: [],
    },
    knowledgeBaseIds: [],
    metadata: {},
    isActive: true,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<AIWorkerSessionProfile> = {}): AIWorkerSessionProfile {
  return {
    sessionId: "sess-1",
    conversationId: "conv-1",
    contactId: "c-1",
    customer: { name: "Acme Co", email: "ops@acme.com" },
    pipeline: {},
    behavior: {},
    capturedAt: "2026-05-24T10:00:00Z",
    ...overrides,
  };
}

describe("session registry", () => {
  beforeEach(() => {
    __clearRegistryForTests();
    __clearSeenForTests();
  });
  afterEach(() => {
    __clearRegistryForTests();
    __clearSeenForTests();
  });

  it("returns the same WorkerSession object on repeat open with same sessionId", () => {
    const a = getOrCreateSession({
      sessionId: "sess-1",
      worker: makeWorker(),
      profile: makeProfile(),
    });
    const b = getOrCreateSession({
      sessionId: "sess-1",
      worker: makeWorker(),
      profile: makeProfile(),
    });
    expect(a).toBe(b); // same object reference - frozen, not rebuilt
  });

  it("computes a stable fingerprint across two cold opens with same inputs", () => {
    const a = getOrCreateSession({
      sessionId: "sess-A",
      worker: makeWorker(),
      profile: makeProfile({ sessionId: "sess-A" }),
    });
    releaseSession("sess-A");
    __clearSeenForTests(); // simulate a fresh process
    const b = getOrCreateSession({
      sessionId: "sess-A",
      worker: makeWorker(),
      profile: makeProfile({ sessionId: "sess-A" }),
    });
    expect(a.fingerprint.hash).toBe(b.fingerprint.hash);
  });

  it("different worker skill set produces different fingerprint", () => {
    const a = getOrCreateSession({
      sessionId: "sess-A",
      worker: makeWorker({ skillIds: ["sales"] }),
      profile: makeProfile({ sessionId: "sess-A" }),
    });
    const b = getOrCreateSession({
      sessionId: "sess-B",
      worker: makeWorker({ skillIds: ["support"] }),
      profile: makeProfile({ sessionId: "sess-B" }),
    });
    expect(a.fingerprint.hash).not.toBe(b.fingerprint.hash);
  });

  it("different customer profile produces different fingerprint", () => {
    const a = getOrCreateSession({
      sessionId: "sess-A",
      worker: makeWorker(),
      profile: makeProfile({ sessionId: "sess-A", customer: { name: "Acme" } }),
    });
    const b = getOrCreateSession({
      sessionId: "sess-B",
      worker: makeWorker(),
      profile: makeProfile({ sessionId: "sess-B", customer: { name: "Globex" } }),
    });
    expect(a.fingerprint.hash).not.toBe(b.fingerprint.hash);
  });

  it("recordPrefixFingerprint trips an exception when the same sessionId yields a different hash (dev)", () => {
    // Open a session, then try to re-record with a tampered hash.
    getOrCreateSession({
      sessionId: "sess-X",
      worker: makeWorker(),
      profile: makeProfile({ sessionId: "sess-X" }),
    });
    // Manually compute a divergent fingerprint to simulate drift
    const tampered = fingerprintPrefix("CHANGED CORE", "CHANGED PROFILE");
    // Re-running recordPrefixFingerprint via verifySessionFingerprint
    // won't drift (it re-reads the same in-memory bytes). Simulate
    // drift by directly calling the record/assert pair.
    const result = recordPrefixFingerprint("sess-X", tampered.hash);
    expect(result.drifted).toBe(true);
    expect(() => assertPrefixStability(result)).toThrow(/DRIFT/);
  });

  it("frozen pipeline snapshot survives - re-opening with mutated profile pipeline is ignored", () => {
    const profile1 = makeProfile({
      sessionId: "sess-pip",
      pipeline: { currentStageId: "discovery", currentStageLabel: "Discovery" },
    });
    const a = getOrCreateSession({
      sessionId: "sess-pip",
      worker: makeWorker({ skillIds: ["pipeline_transitions"] }),
      profile: profile1,
    });
    // Caller "mutates" the profile by sending a new pipeline snapshot
    // mid-session. The registry returns the FROZEN original, not a rebuild.
    const profile2 = makeProfile({
      sessionId: "sess-pip",
      pipeline: { currentStageId: "demo", currentStageLabel: "Demo" },
    });
    const b = getOrCreateSession({
      sessionId: "sess-pip",
      worker: makeWorker({ skillIds: ["pipeline_transitions"] }),
      profile: profile2,
    });
    expect(b).toBe(a);
    expect(b.profile.pipeline?.currentStageId).toBe("discovery");
  });
});
