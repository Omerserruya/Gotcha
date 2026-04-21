import { describe, it, expect } from "vitest";
import { mulawDecode } from "../audio/mulaw";

describe("mulawDecode", () => {
  it("empty buffer returns empty Int16Array", () => {
    const result = mulawDecode(Buffer.alloc(0));
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(0);
  });

  it("known ITU-T G.711 reference vectors decode correctly", () => {
    // ITU-T G.711 reference points (Sun/CCITT ulaw2linear):
    //   0xFF -> 0   (max positive code, zero output)
    //   0x7F -> 0   (max negative code, zero output)
    //   0x80 -> 32124  (lowest negative code → large positive PCM)
    //   0x00 -> -32124 (lowest positive code → large negative PCM)
    const input = Buffer.from([0xff, 0x7f, 0x80, 0x00]);
    const result = mulawDecode(input);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(32124);
    expect(result[3]).toBe(-32124);
  });

  it("160-byte frame (20 ms @ 8 kHz) decodes to exactly 160 Int16 samples", () => {
    const frame = Buffer.alloc(160, 0xff); // silence (0xFF = 0 in μ-law)
    const result = mulawDecode(frame);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(160);
    // All samples should be 0 (silence)
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(0);
    }
  });

  it("is idempotent: calling decode twice on same buffer returns equal arrays", () => {
    const buf = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x3c, 0xaa]);
    const first = mulawDecode(buf);
    const second = mulawDecode(buf);
    expect(first.length).toBe(second.length);
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).toBe(second[i]);
    }
  });

  it("output length always equals input length for arbitrary input", () => {
    for (const len of [1, 10, 255, 256]) {
      const buf = Buffer.alloc(len, 0x7f);
      expect(mulawDecode(buf).length).toBe(len);
    }
  });
});
