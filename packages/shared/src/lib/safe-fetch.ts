import dns from "dns";
import net from "net";

/**
 * SSRF-hardened fetch. The ONE place server-side outbound fetches of
 * user/tenant-supplied URLs are allowed (knowledge-base ingestion, onboarding
 * crawler, flow HTTP node). Do NOT call bare fetch() on a URL that originates
 * from a request body.
 *
 * Protections:
 *  - scheme allowlist (http/https only)
 *  - DNS resolution + block-check of EVERY resolved address (defeats a public
 *    hostname that resolves to a private/link-local/metadata IP, i.e. DNS
 *    rebinding at request time)
 *  - manual redirect handling with per-hop re-validation (defeats a public URL
 *    that 3xx-redirects to an internal target)
 *  - request timeout and a response-size cap
 *
 * Residual: a sub-second TOCTOU rebinding window between the lookup and the
 * socket connect remains (node fetch re-resolves). The short timeout plus the
 * per-hop revalidation make this impractical; pinning to the validated IP is a
 * future hardening. This is a strong floor, intentionally paired with allowlists
 * where callers can supply one.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** True if a dotted-decimal IPv4 literal is private/loopback/metadata/etc. */
function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> block
  if (p[0] === 10) return true; // private
  if (p[0] === 127) return true; // loopback
  if (p[0] === 0) return true; // "this host"
  if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
  if (p[0] === 192 && p[1] === 168) return true; // private
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Expand any valid IPv6 literal to its 16 bytes. Handles `::` compression and a
 * trailing dotted-quad (IPv4-mapped/compatible forms). Returns null if it does
 * not parse as IPv6.
 */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zoneIdx = s.indexOf("%"); // strip a scope/zone id (fe80::1%eth0)
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx);

  // A trailing dotted-quad becomes two 16-bit groups.
  let tailBytes: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = tail.split(".").map((n) => parseInt(n, 10));
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tailBytes = q;
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder two groups, replaced below
  }

  const hasDouble = s.includes("::");
  const [head, rest] = hasDouble ? s.split("::") : [s, undefined];
  const headGroups = head ? head.split(":").filter((g) => g !== "") : [];
  const tailGroups = rest !== undefined && rest ? rest.split(":").filter((g) => g !== "") : [];

  let groups: string[];
  if (hasDouble) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  // Overlay the real dotted-quad tail if present.
  if (tailBytes.length === 4) {
    bytes[12] = tailBytes[0]; bytes[13] = tailBytes[1];
    bytes[14] = tailBytes[2]; bytes[15] = tailBytes[3];
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * True if an IP literal is loopback, private, link-local, metadata, ULA, or an
 * IPv6 form that embeds/routes to such a v4 address. Brackets and zone ids are
 * tolerated. IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`), and NAT64
 * (`64:ff9b::/96`) targets are decoded to their embedded v4 in ANY notation
 * (dotted OR hex-colon), closing the notation-dependent bypass.
 */
export function isBlockedIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[/, "").replace(/\]$/, ""); // tolerate brackets
  const v = net.isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // unparseable IPv6 -> block (fail safe)

    // loopback ::1 and unspecified ::
    if (bytes.every((b, i) => (i < 15 ? b === 0 : true)) && (bytes[15] === 0 || bytes[15] === 1)) return true;

    const b0 = bytes[0], b1 = bytes[1];
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // link-local fe80::/10
    if ((b0 & 0xfe) === 0xfc) return true;                // ULA fc00::/7

    const embeddedV4 = () => `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    // IPv4-mapped ::ffff:0:0/96  (bytes 0-9 = 0, 10-11 = 0xffff)
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    // IPv4-compatible ::/96 (deprecated but routable): bytes 0-11 = 0, not :: / ::1
    const compat = bytes.slice(0, 12).every((b) => b === 0) && (bytes[12] !== 0 || bytes[13] !== 0 || bytes[14] !== 0);
    // NAT64 well-known prefix 64:ff9b::/96
    const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0);
    if (mapped || compat || nat64) return isBlockedV4(embeddedV4());

    return false;
  }
  return true; // not a valid IP literal -> block (fail safe)
}

/** Obvious hostname blocks before DNS (cheap short-circuit). */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

/**
 * Validate a URL for outbound use: http(s) only, and every DNS-resolved address
 * must be public. Throws SsrfError otherwise. Returns the parsed URL.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`blocked scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (isBlockedHostname(host)) throw new SsrfError(`blocked host: ${host}`);

  // If the host is an IP literal, check it directly; else resolve all A/AAAA.
  // URL hostnames keep the brackets on an IPv6 literal, so strip them before
  // net.isIP - otherwise every IPv6 literal falls through to the DNS branch and
  // its address is never checked by isBlockedIp.
  const bareHost = host.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(bareHost)) {
    if (isBlockedIp(bareHost)) throw new SsrfError(`blocked address: ${host}`);
    return parsed;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new SsrfError(`DNS resolution failed for ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`no addresses for ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new SsrfError(`${host} resolves to blocked address ${a.address}`);
  }
  return parsed;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType?: string;
  error?: string;
}

/**
 * Perform an SSRF-safe outbound request. Follows redirects manually, revalidating
 * each hop. Returns a plain result object (never throws for network/SSRF errors;
 * they map to ok:false).
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10_000,
    maxRedirects = 4,
    maxBytes = 5_000_000,
  } = options;

  let currentUrl = rawUrl;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const parsed = await assertPublicUrl(currentUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(parsed.toString(), {
          method,
          headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
          body: body && body.length > 0 ? body : undefined,
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // Manual redirect: re-validate the next hop before following.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, status: res.status, text: "", error: "redirect without location" };
        currentUrl = new URL(location, parsed).toString();
        continue;
      }

      // Read with a size cap.
      const buf = await res.arrayBuffer();
      const text = Buffer.from(buf).slice(0, maxBytes).toString("utf8");
      return { ok: res.ok, status: res.status, text, contentType: res.headers.get("content-type") ?? undefined };
    }
    return { ok: false, status: 0, text: "", error: "too many redirects" };
  } catch (err) {
    const msg = err instanceof SsrfError ? err.message : (err as Error).message;
    return { ok: false, status: 0, text: "", error: msg };
  }
}
