import { describe, it, expect } from "vitest";
import { buildTemplateComponents, renderTemplateText, extractPlaceholders } from "../template-components";

describe("template components (one shared copy, the broadcast worker's rules)", () => {
  it("positional placeholders in numeric order, blanks fall back to the sample then '-'", () => {
    const t = { body: "Hi {{2}} and {{1}}, see {{3}}", variables: [{ key: "3", sample: "the link" }] };
    expect(buildTemplateComponents(t, { "1": "Dana", "2": "" })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Dana" }, { type: "text", text: "-" }, { type: "text", text: "the link" }] },
    ]);
  });
  it("named placeholders carry parameter_name", () => {
    expect(buildTemplateComponents({ body: "Hi {{first_name}}" }, { first_name: "Noa" })).toEqual([
      { type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Noa" }] },
    ]);
  });
  it("a text header is filled; a body with no placeholders adds nothing", () => {
    expect(buildTemplateComponents({ headerType: "TEXT", headerContent: "Order {{1}}", body: "Thanks" }, { "1": "#1001" })).toEqual([
      { type: "header", parameters: [{ type: "text", text: "#1001" }] },
    ]);
  });
  it("renders the text the customer reads, the same way", () => {
    expect(renderTemplateText({ body: "Hi {{1}}, {{2}}", variables: [{ key: "2", sample: "welcome back" }] }, { "1": "Dana" })).toBe("Hi Dana, welcome back");
    expect(extractPlaceholders("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
  });
});
