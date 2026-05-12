import { describe, expect, it } from "vitest";
import {
  appendHistory,
  assertTransition,
  canTransition,
  fromLegacyStatus,
  InvalidTransitionError,
  LIVE_STATES,
  TERMINAL_STATES,
  toLegacyStatus,
  type CallState,
  type StateHistoryEntry,
} from "../state/call-state-machine";

describe("call-state-machine", () => {
  describe("canTransition / assertTransition", () => {
    const happyPath: Array<[CallState, CallState]> = [
      ["RINGING", "CONNECTING"],
      ["CONNECTING", "ACTIVE"],
      ["ACTIVE", "HOLD"],
      ["HOLD", "ACTIVE"],
      ["ACTIVE", "ENDED"],
    ];
    it.each(happyPath)("permits %s → %s", (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });

    const rejections: Array<[CallState, CallState]> = [
      ["ENDED", "ACTIVE"],
      ["FAILED", "ENDED"],
      ["MISSED", "RINGING"],
      ["RINGING", "ACTIVE"], // must go through CONNECTING
      ["ACTIVE", "RINGING"],
      ["HOLD", "RINGING"],
    ];
    it.each(rejections)("rejects %s → %s", (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
    });

    it("permits ringing → missed (no answer)", () => {
      expect(canTransition("RINGING", "MISSED")).toBe(true);
    });

    it("forbids missed → anything", () => {
      for (const to of ["RINGING", "ACTIVE", "ENDED", "FAILED"] as CallState[]) {
        expect(canTransition("MISSED", to)).toBe(false);
      }
    });
  });

  describe("terminal/live sets", () => {
    it("identifies terminal states", () => {
      expect(TERMINAL_STATES.has("ENDED")).toBe(true);
      expect(TERMINAL_STATES.has("FAILED")).toBe(true);
      expect(TERMINAL_STATES.has("MISSED")).toBe(true);
      expect(TERMINAL_STATES.has("ACTIVE")).toBe(false);
    });
    it("identifies live (busy) states", () => {
      expect(LIVE_STATES.has("CONNECTING")).toBe(true);
      expect(LIVE_STATES.has("ACTIVE")).toBe(true);
      expect(LIVE_STATES.has("HOLD")).toBe(true);
      expect(LIVE_STATES.has("RINGING")).toBe(false);
      expect(LIVE_STATES.has("ENDED")).toBe(false);
    });
  });

  describe("legacy status translation", () => {
    it("translates FSM → legacy", () => {
      expect(toLegacyStatus("RINGING")).toBe("ringing");
      expect(toLegacyStatus("CONNECTING")).toBe("in-progress");
      expect(toLegacyStatus("ACTIVE")).toBe("in-progress");
      expect(toLegacyStatus("HOLD")).toBe("in-progress");
      expect(toLegacyStatus("ENDED")).toBe("completed");
      expect(toLegacyStatus("FAILED")).toBe("failed");
      expect(toLegacyStatus("MISSED")).toBe("no-answer");
    });

    it("translates legacy → FSM with sane defaults", () => {
      expect(fromLegacyStatus("ringing")).toBe("RINGING");
      expect(fromLegacyStatus("in-progress")).toBe("ACTIVE");
      expect(fromLegacyStatus("completed")).toBe("ENDED");
      expect(fromLegacyStatus("failed")).toBe("FAILED");
      expect(fromLegacyStatus("no-answer")).toBe("MISSED");
      expect(fromLegacyStatus("anything-else")).toBe("ENDED");
    });
  });

  describe("appendHistory", () => {
    it("appends to empty history", () => {
      const next = appendHistory([], "RINGING", "inbound");
      expect(next).toHaveLength(1);
      expect(next[0].state).toBe("RINGING");
      expect(next[0].reason).toBe("inbound");
      expect(typeof next[0].at).toBe("string");
    });

    it("treats non-array history as empty", () => {
      const next = appendHistory(null, "RINGING");
      expect(next).toHaveLength(1);
    });

    it("preserves prior entries (append-only)", () => {
      const prior: StateHistoryEntry[] = [{ state: "RINGING", at: "2026-01-01T00:00:00Z" }];
      const next = appendHistory(prior, "CONNECTING", "claim");
      expect(next).toHaveLength(2);
      expect(next[0]).toEqual(prior[0]);
      expect(next[1].state).toBe("CONNECTING");
    });

    it("omits reason key when not supplied", () => {
      const next = appendHistory([], "ACTIVE");
      expect(next[0]).not.toHaveProperty("reason");
    });
  });
});
