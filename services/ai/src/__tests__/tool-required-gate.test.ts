import { describe, it, expect } from "vitest";
import { missingRequiredArgs } from "../services/ai-bot.service";
import { missingContractInputs, TOOL_CONTRACTS } from "../services/tool-contracts";

const TOOLS = [
  { type: "function", function: { name: "refund_order", parameters: { required: ["order_id", "reason", "confirmation"] } } },
  { type: "function", function: { name: "check_shipment", parameters: { required: ["order_id"] } } },
  { type: "function", function: { name: "list_events", parameters: { properties: {} } } }, // no required
];

describe("missingRequiredArgs — structural tool-input gate", () => {
  it("flags every missing required field", () => {
    expect(missingRequiredArgs("refund_order", { order_id: "A1" }, TOOLS)).toEqual(["reason", "confirmation"]);
  });

  it("passes when all required fields are present", () => {
    expect(missingRequiredArgs("refund_order", { order_id: "A1", reason: "damaged", confirmation: true }, TOOLS)).toEqual([]);
  });

  it("treats empty-string as missing (won't fire a write on blanks)", () => {
    expect(missingRequiredArgs("check_shipment", { order_id: "  " }, TOOLS)).toEqual(["order_id"]);
  });

  it("accepts falsy-but-present values (0 / false are NOT missing)", () => {
    const tools = [{ type: "function", function: { name: "t", parameters: { required: ["n", "b"] } } }];
    expect(missingRequiredArgs("t", { n: 0, b: false }, tools)).toEqual([]);
  });

  it("returns [] for tools with no required array", () => {
    expect(missingRequiredArgs("list_events", {}, TOOLS)).toEqual([]);
  });

  it("returns [] for an unknown tool (nothing to enforce)", () => {
    expect(missingRequiredArgs("nope", {}, TOOLS)).toEqual([]);
  });
});

describe("missingContractInputs — Tool Contract registry gate", () => {
  it("blocks an integration tool whose contract-required input is missing", () => {
    const r = missingContractInputs("check_shipment", {});
    expect(r.missing).toEqual(["order_number"]);
    expect(r.strategy).toBe("ask_one_at_a_time");
  });

  it("passes once the contract-required input is present", () => {
    expect(missingContractInputs("check_shipment", { order_number: "X9" }).missing).toEqual([]);
  });

  it("treats blank / empty-array values as missing", () => {
    expect(missingContractInputs("issue_refund", { order_id: "   " }).missing).toEqual(["order_id"]);
  });

  it("returns empty for a tool with no contract (schema gate still applies separately)", () => {
    expect(missingContractInputs("schedule_meeting", {}).missing).toEqual([]);
  });

  it("does NOT contract-gate schedule_meeting (propose-slots flow stays intact)", () => {
    expect(TOOL_CONTRACTS.schedule_meeting).toBeUndefined();
  });
});
