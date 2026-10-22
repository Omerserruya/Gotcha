/**
 * ★ Pins the "[CODE] sentence" format, the twin of auth's and ai's
 * lib/error-code (2026-10-09). A drift here and v2 reads an unknown reason.
 */
import { describe, it, expect } from "vitest";
import { withErrorCode, splitErrorCode, ERROR_CODES_KNOWN } from "../lib/error-code";

describe("error-code format", () => {
  it("★ a writer stores [CODE], one space, then the sentence", () => {
    expect(withErrorCode("TWILIO_NUMBER_NOT_FOUND")).toBe(
      "[TWILIO_NUMBER_NOT_FOUND] This phone number was not found on the Twilio account.",
    );
  });

  it("★ every code round-trips through split", () => {
    for (const code of Object.keys(ERROR_CODES_KNOWN) as Array<keyof typeof ERROR_CODES_KNOWN>) {
      expect(splitErrorCode(withErrorCode(code))).toEqual({ lastError: ERROR_CODES_KNOWN[code], lastErrorCode: code });
    }
  });

  it("an exact known sentence with no prefix is still recognised", () => {
    expect(splitErrorCode(ERROR_CODES_KNOWN.TWILIO_CREDENTIALS_INVALID)).toEqual({
      lastError: ERROR_CODES_KNOWN.TWILIO_CREDENTIALS_INVALID,
      lastErrorCode: "TWILIO_CREDENTIALS_INVALID",
    });
  });

  it("any other text keeps its words and has no code", () => {
    expect(splitErrorCode("twilio_api_500: boom")).toEqual({ lastError: "twilio_api_500: boom", lastErrorCode: null });
    expect(splitErrorCode("[lower] not a code")).toEqual({ lastError: "[lower] not a code", lastErrorCode: null });
  });

  it("nothing stored is nothing served", () => {
    expect(splitErrorCode(null)).toEqual({ lastError: null, lastErrorCode: null });
    expect(splitErrorCode(undefined)).toEqual({ lastError: null, lastErrorCode: null });
    expect(splitErrorCode("")).toEqual({ lastError: "", lastErrorCode: null });
  });

  it("no sentence carries an em or en dash", () => {
    for (const text of Object.values(ERROR_CODES_KNOWN)) expect(text).not.toMatch(/[\u2013\u2014\u2015]/);
  });
});
