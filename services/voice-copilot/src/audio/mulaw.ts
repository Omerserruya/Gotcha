/**
 * ITU-T G.711 μ-law → linear PCM16 decoder.
 * Pure function, no side effects, no external dependencies.
 * Uses a 256-entry lookup table built once at module load time.
 */

// Build the 256-entry μ-law decode table at module initialisation.
// Algorithm: ITU-T G.711 §4.2
//   1. Invert all bits (XOR 0xFF) to get the "code" byte
//   2. Extract sign bit (bit 7), segment (bits 6-4), mantissa (bits 3-0)
//   3. Reconstruct linear sample:
//      linear = (mantissa << 1 | 0x21) << segment  (in the biased domain)
//      then subtract bias of 33 and restore sign
const MULAW_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    // Invert all bits (ITU-T G.711 complemented code)
    const code = ~i & 0xff;
    const sign = code & 0x80;
    const exponent = (code >> 4) & 0x07;
    const mantissa = code & 0x0f;
    // Reconstruct: expand mantissa into biased domain, shift by exponent,
    // then remove the 0x84 bias to get linear magnitude.
    let magnitude = ((mantissa << 3) + 0x84) << exponent;
    magnitude -= 0x84;
    table[i] = sign !== 0 ? -magnitude : magnitude;
  }
  return table;
})();

/**
 * Decode a Buffer of μ-law encoded bytes to linear PCM 16-bit samples.
 * Output length equals input length. O(n) via lookup table.
 */
export function mulawDecode(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = MULAW_TABLE[mulaw[i]];
  }
  return out;
}
