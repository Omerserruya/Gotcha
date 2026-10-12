import { describe, it, expect } from "vitest";
import { maskPhoneEvidence, maskEmailEvidence } from "../lib/link-evidence";

describe("masking a matched identifier", () => {
  it("Israeli numbers in either form keep the first digit and the last four", () => {
    expect(maskPhoneEvidence("+972541113421")).toBe("+972 5X-XXX-3421");
    expect(maskPhoneEvidence("972-54-111-3421")).toBe("+972 5X-XXX-3421");
    expect(maskPhoneEvidence("054-111-3421")).toBe("05X-XXX-3421");
  });
  it("anything else shows the last four only", () => {
    expect(maskPhoneEvidence("+1 415 555 0199")).toBe("XXX-0199");
    expect(maskPhoneEvidence("12345")).toBe("XXX");
  });
  it("email keeps the first letter and the domain", () => {
    expect(maskEmailEvidence("Omer.S@Gmail.com")).toBe("O***@gmail.com");
    expect(maskEmailEvidence("nodomain")).toBe("***");
  });
});
