/**
 * Telling a Shopify order ID apart from an order NAME.
 *
 * These are different namespaces and the API treats them differently, but a
 * customer only ever sees the name. Matan wrote "#1006"; the model had a tool
 * whose only order parameter was called `order_id`, so it sent "#1006" as an
 * id. The adapter issued `GET /orders/%231006.json` and Shopify answered
 * `400 id: expected String to be a id`. Stripping the "#" on the next attempt
 * produced `GET /orders/1006.json` → `404 Not Found`, because 1006 is the
 * name; the internal id for that order is a 13-digit number.
 *
 * Four failed writes, an escalation, and a customer asking to cancel - all
 * from a value landing in the wrong namespace.
 *
 * Deliberately dependency-free so the whole identifier matrix can be tested
 * without a Shopify connection.
 */

export type OrderIdentifierKind =
  | "internal_id"   // definitely a Shopify internal id (or a GID carrying one)
  | "order_name"    // definitely a human-facing order name
  | "ambiguous"     // could be either; `preferred` decides which to try first
  | "missing"       // nothing usable was supplied
  | "malformed";    // supplied, but not a plausible identifier at all

export interface OrderIdentifier {
  kind: OrderIdentifierKind;
  /**
   * Which namespace to try FIRST when the value could be either.
   *
   * The argument the caller chose is itself evidence: a bare "11" in
   * `order_id` most likely IS an id, and the same value in `order_name` is a
   * name. An explicit "#" overrides both, because that is the customer's own
   * notation. Only ever an ORDER of attempts - both namespaces stay reachable,
   * so a wrong guess costs one extra request rather than a failure.
   */
  preferred?: "id" | "name";
  /** Numeric internal id, when one could be determined. */
  id?: string;
  /** Order name, WITHOUT a leading "#". */
  name?: string;
  /** Human-readable reason, for logs and error messages. Never customer-facing. */
  detail?: string;
}

/**
 * Shopify internal ids are snowflake-ish and long - orders created since ~2016
 * are 13+ digits. Order names are the store's sequential counter and are short
 * (#1001, #1006). Ten digits is comfortably above any realistic order-name
 * counter and below every modern internal id.
 *
 * This is a heuristic, and it is only ever used to decide which lookup to try
 * FIRST. Both paths remain available, so a wrong guess costs one extra request
 * rather than a failed operation - which is the whole point: the previous code
 * had no second path at all.
 */
const INTERNAL_ID_MIN_DIGITS = 10;

/** `gid://shopify/Order/5678901234567` → `5678901234567` */
const GID_RE = /^gid:\/\/shopify\/Order\/(\d+)$/i;

/** A store may prefix names, e.g. "URB-1006" or "EN1006". */
const NAMEY_RE = /^[A-Za-z][A-Za-z0-9-]*\d+$/;

export function classifyOrderIdentifier(raw: unknown): OrderIdentifier {
  if (raw === null || raw === undefined) return { kind: "missing" };

  const value = String(raw).trim();
  if (!value) return { kind: "missing" };

  const gid = value.match(GID_RE);
  if (gid) return { kind: "internal_id", id: gid[1], detail: "shopify gid" };

  // An explicit "#" is the customer's own notation and settles it.
  if (value.startsWith("#")) {
    const name = value.slice(1).trim();
    if (!name) return { kind: "malformed", detail: "'#' with no order number" };
    return { kind: "order_name", name, detail: "hash-prefixed order name" };
  }

  if (/^\d+$/.test(value)) {
    if (value.length >= INTERNAL_ID_MIN_DIGITS) {
      return { kind: "internal_id", id: value, detail: "long numeric" };
    }
    // Short and numeric is genuinely ambiguous: a store's order counter and an
    // old store's internal ids look identical. Which is tried first is decided
    // by the FIELD the caller used (see orderIdentifierFromArgs), and both
    // paths stay open either way.
    return { kind: "ambiguous", name: value, id: value, detail: "short numeric" };
  }

  if (NAMEY_RE.test(value)) {
    return { kind: "order_name", name: value, detail: "prefixed order name" };
  }

  return { kind: "malformed", detail: "not an id, gid or order name" };
}

/**
 * The single identifier for an order, taken from whichever argument carries it.
 *
 * `order_name` wins when both are present: it is the value a customer actually
 * said, so if the two disagree the name is the one to trust.
 */
export function orderIdentifierFromArgs(args: Record<string, unknown>): OrderIdentifier {
  const byName = classifyOrderIdentifier(args?.order_name);
  if (byName.kind === "order_name" || byName.kind === "ambiguous") {
    // A name argument is a name even when it is bare digits.
    return { kind: "order_name", name: byName.name, preferred: "name", detail: "order_name argument" };
  }
  if (byName.kind === "internal_id") return { ...byName, preferred: "id" };

  const byId = classifyOrderIdentifier(args?.order_id);
  if (byId.kind === "missing" && byName.kind === "malformed") return byName;
  // A bare numeric in `order_id` is most likely an id - that is what the field
  // says. "#1006" is already classified as a name above and is unaffected.
  if (byId.kind === "ambiguous") return { ...byId, preferred: "id" };
  return { ...byId, preferred: byId.kind === "order_name" ? "name" : "id" };
}

/**
 * A stable key for "the same order was asked about again", used by the
 * repeat-call guard. Both "#1006" and " 1006 " collapse to the same key, so a
 * model retrying the same failing write with cosmetically different arguments
 * is still recognised as repeating itself.
 */
export function orderIdentifierKey(id: OrderIdentifier): string {
  if (id.name) return `name:${id.name.toLowerCase()}`;
  if (id.id) return `id:${id.id}`;
  return id.kind;
}
