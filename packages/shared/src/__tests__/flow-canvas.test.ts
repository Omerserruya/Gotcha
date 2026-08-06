/**
 * "on first steps - even if a flow is set and saved, it doesnt mark as done!"
 *
 * Two separate faults produced that. The journey counted `chatbotFlow`, a
 * legacy store the builder never writes - so no saved process could ever mark
 * the milestone. And the canvas that customer had saved held exactly one node,
 * a channel_entry, with zero edges: a trigger that leads nowhere, because a
 * handle-id mismatch made every trigger → action connection impossible.
 *
 * The production row, verbatim: nodes=1, edges=0, types ["channel_entry"].
 */
import { describe, it, expect } from "vitest";
import { canvasHasRunnableProcess, isFlowTrigger } from "../lib/flow-canvas";

const trigger = { id: "t1", type: "channel_entry", data: {} };
const action = { id: "a1", type: "send_message_text", data: { text: "hi" } };

describe("canvasHasRunnableProcess", () => {
  it("is done when a trigger leads to an action", () => {
    expect(
      canvasHasRunnableProcess([trigger, action], [{ source: "t1", target: "a1" }]),
    ).toBe(true);
  });

  it("is NOT done for the lone trigger this customer actually saved", () => {
    // Marking this done would tell them their automation is live while the
    // executor starts at the trigger, follows no edge, and answers nothing.
    expect(canvasHasRunnableProcess([trigger], [])).toBe(false);
  });

  it("is not done when the trigger's edge points at a node that was deleted", () => {
    expect(canvasHasRunnableProcess([trigger], [{ source: "t1", target: "gone" }])).toBe(false);
  });

  it("is not done for an action wired to an action with no trigger at all", () => {
    const a2 = { id: "a2", type: "send_message_image", data: {} };
    expect(canvasHasRunnableProcess([action, a2], [{ source: "a1", target: "a2" }])).toBe(false);
  });

  it("does not count a trigger wired to another trigger", () => {
    const t2 = { id: "t2", type: "keyword_trigger", data: {} };
    expect(canvasHasRunnableProcess([trigger, t2], [{ source: "t1", target: "t2" }])).toBe(false);
  });

  it("accepts every trigger family, including namespaced voice triggers", () => {
    for (const type of ["keyword_trigger", "comment_trigger", "schedule_trigger", "webhook_trigger", "start", "voice_trigger:call.incoming"]) {
      expect(
        canvasHasRunnableProcess([{ id: "t", type }, action], [{ source: "t", target: "a1" }]),
      ).toBe(true);
    }
  });

  it("answers false rather than throwing on a malformed canvas", () => {
    // These columns are untyped Json; the journey endpoint must not 500 on one.
    expect(canvasHasRunnableProcess(null, null)).toBe(false);
    expect(canvasHasRunnableProcess(undefined, undefined)).toBe(false);
    expect(canvasHasRunnableProcess("[]" as unknown, [])).toBe(false);
    expect(canvasHasRunnableProcess([null, 7, trigger], [null, { source: "t1" }])).toBe(false);
  });
});

describe("isFlowTrigger", () => {
  it("recognises namespaced voice triggers without listing all seven", () => {
    expect(isFlowTrigger("voice_trigger:call.keyword_spoken")).toBe(true);
    expect(isFlowTrigger("send_message_text")).toBe(false);
    expect(isFlowTrigger(undefined)).toBe(false);
  });
});
