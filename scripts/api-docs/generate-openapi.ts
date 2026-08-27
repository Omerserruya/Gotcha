/**
 * Turn the extracted route inventory into docs/openapi.yaml (OpenAPI 3.1).
 *
 * Everything here is derived. Nothing is hand-written per endpoint, because a
 * hand-written spec over 700+ routes cannot be kept true - and a spec that is
 * quietly false about which endpoints require authentication is worse than no
 * spec at all.
 *
 * Where the source does not say something (most response bodies have no schema
 * anywhere in the codebase), the operation says so explicitly rather than
 * inventing a shape. `x-documentation-gap` marks those, so the gaps are
 * countable instead of invisible.
 *
 * Run: npx tsx scripts/api-docs/generate-openapi.ts
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");

// ─── YAML emitter ───────────────────────────────────────────
//
// Hand-rolled rather than `import YAML from "yaml"`, because `yaml` is not a
// declared dependency of this repo - it only resolved from a nested transitive
// copy, so the generator would break on the next clean install. The repo
// forbids adding dependencies, and a documentation pipeline that stops working
// after `npm ci` is not maintainable.
//
// Only the subset OpenAPI needs: maps, sequences, strings, numbers, booleans.
// No anchors, no aliases, no custom tags.

/** Plain scalars that YAML would otherwise reinterpret as another type. */
const NEEDS_QUOTING =
  /^(|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|no|No|on|On|off|Off|[-+]?[0-9.]+([eE][-+]?[0-9]+)?|0[xX][0-9a-fA-F]+)$/;

function yamlString(v: string, indent: string): string {
  // Multi-line text becomes a literal block scalar, which keeps long
  // descriptions readable instead of one escaped ribbon.
  if (v.includes("\n")) {
    const body = v
      .split("\n")
      .map((l) => (l.length ? `${indent}  ${l}` : ""))
      .join("\n");
    // `|-` strips the trailing newline; the chomp indicator matters because
    // without it every description gains a blank line on round-trip.
    return `|-\n${body}`;
  }
  const mustQuote =
    NEEDS_QUOTING.test(v) ||
    /^[\s]|[\s]$/.test(v) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(v) ||
    /:\s/.test(v) ||
    v.includes(" #") ||
    v.includes("\t");
  if (!mustQuote) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlKey(k: string): string {
  return /^[A-Za-z0-9_./{}$-]+$/.test(k) && !NEEDS_QUOTING.test(k)
    ? k
    : `"${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toYaml(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return yamlString(value, indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, depth + 1);
        const isBlock = item !== null && typeof item === "object";
        return isBlock && rendered !== "{}" && rendered !== "[]"
          ? `${indent}- ${rendered.slice((depth + 1) * 2)}`
          : `${indent}- ${rendered}`;
      })
      .join("\n");
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return "{}";

  return entries
    .map(([k, v]) => {
      const key = `${indent}${yamlKey(k)}:`;
      if (v === null || typeof v !== "object") return `${key} ${toYaml(v, depth)}`;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${key} []`;
        return `${key}\n${toYaml(v, depth)}`;
      }
      const rendered = toYaml(v, depth + 1);
      return rendered === "{}" ? `${key} {}` : `${key}\n${rendered}`;
    })
    .join("\n");
}


const INVENTORY = path.join(REPO_ROOT, "docs/.api-extract/route-inventory.json");
const OUT = path.join(REPO_ROOT, "docs/openapi.yaml");

interface Route {
  service: string; path: string; method: string; publicPath: string | null;
  exposedPublicly: boolean; file: string; line: number;
  auth: any; requestSchemaName: string | null; requestSchema: any;
  pathParams: string[]; queryParams: string[]; statusCodes: number[];
  readOnly: boolean; multipart: boolean; comment: string | null;
  dbOps: Array<{ model: string; op: string }>; sideEffects: string[]; serviceCalls: string[];
}

// ─── Domain tags ────────────────────────────────────────────

// Longest prefix wins, so /api/channels/whatsapp lands on WhatsApp rather than
// Channels. Shared with generate-execution-map.ts via tag-map.json so the two
// documents can never disagree about which domain an endpoint belongs to.
const TAGS: Array<[string, string]> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "tag-map.json"), "utf8"),
);

const TAG_DESCRIPTIONS: Record<string, string> = {
  "Auth & Identity": "Sign-in surface, the current principal, account self-service and the tenant-local permission model. GOTCHA implements no authentication itself: Authentik issues the token and this service verifies it.",
  "Onboarding": "The guided setup a new workspace runs once, plus the public invitation and waitlist endpoints that precede it.",
  "Tenant Settings": "Workspace configuration: departments, business policies, custom field definitions and general settings.",
  "Conversations": "The inbox. Conversations, messages, routing rules, templates, broadcasts and scheduled sends.",
  "Contacts & CRM": "Customer records, identity resolution and the CRM panel that reads from connected systems.",
  "Channels": "Connecting and managing messaging channels, including the OAuth flows that link them.",
  "WhatsApp": "WhatsApp Business specifics: numbers, Embedded Signup and per-number health.",
  "Knowledge": "Knowledge bases, documents and the connected sources (Google Drive, Confluence) that keep them current.",
  "AI Studio": "Configuring AI employees: agents, tools, flows, funnels, approvals and the reasoning surfaces behind them.",
  "Integrations": "Third-party business systems - CRMs, calendars and commerce platforms - and their OAuth connections.",
  "Shopify": "The Shopify app: storefront live chat, install flow and commerce context.",
  "Billing": "Plans, pricing, checkout, invoices, AI credits and coupons.",
  "Analytics": "Reporting over conversations, agents and usage.",
  "Notifications": "Notification delivery and per-user preferences.",
  "Voice": "The voice channel: inbound calls, live sessions, conference control and Twilio callbacks.",
  "Embedded Chat": "The website widget that embeds on a customer's own site.",
  "Webhooks": "Inbound provider callbacks. These are authenticated by signature or shared secret, never by a user token.",
  "GDPR & Compliance": "Data subject rights: export, erasure and consent records.",
  "Historical Import": "One-time import of prior conversation history from a connected channel.",
  "Platform Admin": "GOTCHA staff surface, not tenant-facing. Gated on platform admin rather than tenant role.",
  "Public": "Endpoints deliberately reachable without a session.",
  "Internal": "Service-to-service only. Not exposed through the gateway; authenticated by a shared secret.",
};

function tagFor(p: string): string {
  let best: [string, string] | null = null;
  for (const entry of TAGS) {
    if (p === entry[0] || p.startsWith(entry[0] + "/") || p.startsWith(entry[0])) {
      if (!best || entry[0].length > best[0].length) best = entry;
    }
  }
  return best ? best[1] : "Other";
}

// ─── Naming ─────────────────────────────────────────────────

const VERB: Record<string, string> = {
  GET: "Get", POST: "Create", PUT: "Replace", PATCH: "Update", DELETE: "Delete",
};

function humanize(seg: string): string {
  return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A readable summary from the path, used when the source has no comment. */
function summaryFor(r: Route): string {
  const segs = r.path.split("/").filter(Boolean).filter((s) => s !== "api");
  const last = segs[segs.length - 1] ?? "";
  const isCollection = !last.startsWith(":");
  const subject = isCollection
    ? humanize(last)
    : humanize(segs[segs.length - 2] ?? last).replace(/s$/, "");

  if (r.method === "GET") {
    return isCollection && !r.pathParams.length ? `List ${subject}` : `Get ${subject}`;
  }
  if (r.method === "POST" && !isCollection) return `${humanize(last.replace(":", ""))} action`;
  if (r.method === "POST" && segs.length > 1 && !segs[segs.length - 2]?.startsWith(":")) {
    return `${VERB[r.method]} ${subject}`;
  }
  return `${VERB[r.method] ?? r.method} ${subject}`;
}

/** First sentence of the leading comment, cleaned for a one-line description. */
function descriptionFor(r: Route): string {
  const parts: string[] = [];
  if (r.comment) parts.push(r.comment);

  const a = r.auth;
  const authBits: string[] = [];
  if (a.internal) authBits.push("Service-to-service only, authenticated by the internal shared secret.");
  else if (a.signatureVerified) authBits.push("Authenticated by provider signature, not by a user token.");
  else if (a.authenticate) authBits.push("Requires a valid Authentik access token.");
  else if (a.optionalAuth) authBits.push("Authentication is optional; the caller is identified when a token is present.");
  else authBits.push("No authentication middleware is applied to this route.");

  if (a.resolveTenant) authBits.push("Tenant is resolved from the token, never from the request body.");
  if (a.tenantState) authBits.push(`Tenant status must be ${a.tenantState}.`);
  if (a.mfaRequired) authBits.push("The caller must have MFA enrolled.");
  if (a.crossTenant) authBits.push("Deliberately spans tenants.");
  parts.push(authBits.join(" "));

  if (!r.readOnly) parts.push("This is a write operation.");
  if (r.sideEffects.length) parts.push(`Side effects: ${r.sideEffects.join("; ")}.`);

  parts.push(`Implemented at \`${r.file}:${r.line}\` (${r.service} service).`);
  return parts.join("\n\n");
}

// ─── Security ───────────────────────────────────────────────

function securityFor(r: Route): any[] | undefined {
  const a = r.auth;
  if (a.internal) return [{ internalServiceToken: [] }];
  if (a.signatureVerified) return [{ providerSignature: [] }];
  if (a.authenticate) return [{ bearerAuth: [] }];
  if (a.optionalAuth) return [{ bearerAuth: [] }, {}];
  return []; // explicitly public
}

/** Human-readable authorization requirements, as an extension field. */
function authzFor(r: Route): Record<string, any> | undefined {
  const a = r.auth;
  const out: Record<string, any> = {};
  if (a.roles.length) out.roles = a.roles;
  if (a.permissions.length) out.permissions = a.permissions;
  if (a.permissionOrRole.length) {
    out.permissionOrRole = a.permissionOrRole.map((p: any) => `${p.permission} OR role ${p.role}`);
  }
  if (a.adminGates.length) out.platformAdmin = a.adminGates;
  if (a.permissionGates.length) out.gates = a.permissionGates;
  if (a.features.length) out.featureFlags = a.features;
  if (a.entitlements.length) out.entitlements = a.entitlements;
  if (a.capacity.length) out.planLimits = a.capacity;
  if (a.mfaRequired) out.mfa = "required";
  if (a.crossTenant) out.crossTenant = true;
  return Object.keys(out).length ? out : undefined;
}

// ─── Responses ──────────────────────────────────────────────

const STATUS_TEXT: Record<number, string> = {
  200: "Success", 201: "Created", 202: "Accepted for asynchronous processing",
  204: "No content", 302: "Redirect",
  400: "Validation failed or the request was malformed",
  401: "Missing, invalid or expired access token",
  402: "Payment required - the workspace is not in a billable state",
  403: "Authenticated, but not permitted to perform this operation",
  404: "Not found, or not visible to this tenant",
  409: "Conflict with current state",
  410: "Gone - the resource expired or was superseded",
  413: "Payload too large",
  422: "Semantically invalid",
  429: "Rate limited",
  500: "Unexpected server error",
  502: "Upstream provider error", 503: "Temporarily unavailable",
};

function responsesFor(r: Route): Record<string, any> {
  const codes = new Set<number>(r.statusCodes);
  // A handler that never calls res.status() still answers; Express defaults to
  // 200. Inferring the success code rather than omitting it keeps the spec
  // usable, and it is marked as inferred so nobody mistakes it for a promise.
  const hasSuccess = [...codes].some((c) => c < 400);
  let inferredSuccess = false;
  if (!hasSuccess) {
    codes.add(r.method === "POST" ? 201 : 200);
    inferredSuccess = true;
  }
  if (r.auth.authenticate) codes.add(401);
  if (authzFor(r)) codes.add(403);
  if (r.auth.rateLimiters.length) codes.add(429);

  const out: Record<string, any> = {};
  for (const c of [...codes].sort((a, b) => a - b)) {
    const isSuccess = c < 400;
    const entry: any = { description: STATUS_TEXT[c] ?? `HTTP ${c}` };
    if (isSuccess && c !== 204 && c !== 302) {
      entry.content = {
        "application/json": {
          schema: { $ref: "#/components/schemas/EnvelopeUnknown" },
        },
      };
      if (inferredSuccess && c === [...codes].filter((x) => x < 400)[0]) {
        entry["x-inferred"] = "Status inferred from Express defaults; the handler calls no explicit res.status() for success.";
      }
    } else if (!isSuccess) {
      entry.content = {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      };
    }
    out[String(c)] = entry;
  }
  return out;
}

// ─── Parameters ─────────────────────────────────────────────

function parametersFor(r: Route): any[] {
  const params: any[] = [];
  for (const p of r.pathParams) {
    params.push({
      name: p, in: "path", required: true,
      schema: { type: "string" },
      description: `\`${p}\` path segment.`,
    });
  }
  for (const q of r.queryParams) {
    params.push({
      name: q, in: "query", required: false,
      schema: { type: "string" },
      description: "Read from `req.query` by the handler; type is not declared in source.",
    });
  }
  return params;
}

function requestBodyFor(r: Route): any | undefined {
  if (["GET", "DELETE"].includes(r.method) && !r.requestSchema) return undefined;
  if (r.multipart) {
    return {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: { file: { type: "string", format: "binary" } },
            required: ["file"],
          },
        },
      },
    };
  }
  if (r.requestSchema) {
    return {
      required: true,
      description: `Validated by \`${r.requestSchemaName}\` (Zod). Unlisted properties are stripped before the handler runs.`,
      content: { "application/json": { schema: r.requestSchema } },
    };
  }
  if (["POST", "PUT", "PATCH"].includes(r.method)) {
    return {
      required: false,
      description: "No Zod schema is declared for this route; the handler reads `req.body` directly. Shape is not verifiable from source.",
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    };
  }
  return undefined;
}

// ─── Build ──────────────────────────────────────────────────

function operationId(r: Route): string {
  const clean = r.path
    .replace(/^\/api\//, "")
    .replace(/[:{}]/g, "")
    .split(/[/\-_]/)
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join("");
  return `${r.method.toLowerCase()}${clean[0]?.toUpperCase() ?? ""}${clean.slice(1)}`;
}

function main(): void {
  const { routes } = JSON.parse(fs.readFileSync(INVENTORY, "utf8")) as { routes: Route[] };

  const paths: Record<string, any> = {};
  const usedIds = new Set<string>();
  let gapCount = 0;

  for (const r of routes) {
    // OpenAPI wants {id}; Express writes :id.
    const specPath = r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    paths[specPath] ??= {};

    let id = operationId(r);
    let n = 2;
    while (usedIds.has(id)) id = `${operationId(r)}${n++}`;
    usedIds.add(id);

    const op: any = {
      operationId: id,
      tags: [tagFor(r.path)],
      summary: summaryFor(r),
      description: descriptionFor(r),
      security: securityFor(r),
      "x-service": r.service,
      "x-source": `${r.file}:${r.line}`,
      "x-operation-type": r.readOnly ? "read" : "write",
      "x-publicly-exposed": r.exposedPublicly,
    };

    const authz = authzFor(r);
    if (authz) op["x-authorization"] = authz;
    if (r.auth.rateLimiters.length) op["x-rate-limit"] = r.auth.rateLimiters;
    if (r.dbOps.length) {
      op["x-database"] = r.dbOps.map((d) => `${d.model}.${d.op}`);
    }
    if (r.sideEffects.length) op["x-side-effects"] = r.sideEffects;
    if (r.serviceCalls.length) op["x-service-calls"] = r.serviceCalls;
    if (r.sideEffects.some((s) => s.startsWith("queue:"))) {
      op["x-async"] = "Enqueues background work; the response returns before that work completes.";
    }

    const params = parametersFor(r);
    if (params.length) op.parameters = params;

    const body = requestBodyFor(r);
    if (body) op.requestBody = body;

    op.responses = responsesFor(r);

    if (!r.requestSchema && ["POST", "PUT", "PATCH"].includes(r.method)) {
      op["x-documentation-gap"] = "request-body-unschematized";
      gapCount++;
    }

    paths[specPath][r.method.toLowerCase()] = op;
  }

  const tagsUsed = [...new Set(routes.map((r) => tagFor(r.path)))].sort();

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "GOTCHA Platform API",
      version: "1.0.0",
      summary: "Multi-tenant customer engagement platform: inbox, AI employees, channels, commerce and billing.",
      description: [
        "## How this document is produced",
        "",
        "This specification is **generated from the source**, not written by hand. `scripts/api-docs/extract-routes.ts`",
        "parses the TypeScript AST of every Express router, resolves the middleware chain (including",
        "`router.use()` inherited middleware, path-scoped `router.use(\"/x\", ...)` and spread arrays like",
        "`...ADMIN_ONLY`), reads Zod schemas referenced by `validate(...)`, and inspects each handler body for",
        "database operations and queue writes. `scripts/api-docs/generate-openapi.ts` then renders this file.",
        "",
        "Regenerate with `npm run api:docs`. CI can assert the checked-in file matches with `npm run api:docs:check`.",
        "",
        "## What is trustworthy here, and what is not",
        "",
        "**Reliable**, because it is read directly from code: paths, methods, which middleware runs, the",
        "authentication and authorization requirements, path parameters, request bodies where a Zod schema",
        "exists, the Prisma models each handler touches, and the queues it writes to.",
        "",
        "**Inferred, and marked as such**: success status codes for handlers that never call `res.status()`",
        "explicitly (Express defaults to 200) carry `x-inferred`.",
        "",
        "**Not available from the source at all**: response body schemas. This codebase declares no response",
        "types anywhere - handlers call `res.json(...)` with ad-hoc objects. Successful responses are typed as",
        "`EnvelopeUnknown`, which documents the observed `{ data: ... }` convention without pretending to know",
        "the shape. Operations whose request body also has no schema are flagged `x-documentation-gap`.",
        "Closing that gap means adding schemas to the code, which is the only place it can be fixed honestly.",
        "",
        "## Conventions",
        "",
        "- **Tenancy.** Almost every endpoint is tenant-scoped. The tenant is resolved from the access token by",
        "  `resolveTenant`, never from a request parameter. Endpoints that deliberately cross tenants are marked",
        "  `x-authorization.crossTenant`.",
        "- **Response envelope.** Handlers overwhelmingly answer `{ \"data\": ... }` on success and",
        "  `{ \"error\": \"...\" }` on failure.",
        "- **Validation.** `validate(schema)` replaces `req.body` with the parsed value, so properties absent from",
        "  the schema are stripped before the handler sees them.",
        "- **Async work.** Operations marked `x-async` enqueue background jobs (BullMQ); the HTTP response",
        "  returns before that work finishes.",
        "- **Internal endpoints.** Operations tagged `Internal` are not routed by the gateway and are only",
        "  reachable service-to-service. `x-publicly-exposed: false` marks them.",
      ].join("\n"),
      contact: { name: "GOTCHA", url: "https://gotcha.co.il" },
    },
    servers: [
      { url: "https://app.gotcha.co.il", description: "Production" },
      { url: "https://dev.gotcha.co.il", description: "Development" },
    ],
    tags: tagsUsed.map((t) => ({ name: t, description: TAG_DESCRIPTIONS[t] ?? "" })),
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http", scheme: "bearer", bearerFormat: "JWT",
          description: [
            "An access token issued by **Authentik**, verified by `authenticate()` in",
            "`packages/shared/src/middleware/auth.ts` against Authentik's JWKS. GOTCHA implements no",
            "authentication of its own: it does not hash passwords, issue tokens, or store sessions.",
            "The token's `sub` resolves to `User.authentikSubject`, and authorization (roles, permissions,",
            "tenancy) is then evaluated entirely from local records.",
          ].join(" "),
        },
        internalServiceToken: {
          type: "apiKey", in: "header", name: "x-internal-key",
          description: "Shared secret for service-to-service calls inside the Docker network. Never valid from outside the gateway.",
        },
        providerSignature: {
          type: "apiKey", in: "header", name: "x-hub-signature-256",
          description: [
            "Provider webhook signature (Meta `x-hub-signature-256`, Shopify `x-shopify-hmac-sha256`,",
            "Twilio `x-twilio-signature`, or a shared push token for Google Pub/Sub). The exact header",
            "varies by provider; verification is mandatory and fails closed.",
          ].join(" "),
        },
      },
      schemas: {
        EnvelopeUnknown: {
          type: "object",
          description: [
            "The success envelope. `data` is deliberately untyped: this codebase declares no response",
            "schemas, so the precise shape is only knowable by reading the handler named in `x-source`.",
            "Typing it here would be a guess presented as a contract.",
          ].join(" "),
          properties: { data: { description: "Operation-specific payload." } },
        },
        Error: {
          type: "object",
          description: "The failure envelope used across services.",
          properties: {
            error: { type: "string", description: "Human-readable failure reason." },
            details: {
              type: "array",
              description: "Field-level validation failures, when the failure came from `validate()`.",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
          required: ["error"],
        },
      },
    },
    paths,
  };

  fs.writeFileSync(OUT, toYaml(spec) + "\n");

  const ops = Object.values(paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0);
  console.error(`operations : ${ops}`);
  console.error(`paths      : ${Object.keys(paths).length}`);
  console.error(`tags       : ${tagsUsed.length}`);
  console.error(`unschematized request bodies: ${gapCount}`);
  console.error(`wrote ${path.relative(REPO_ROOT, OUT)}`);
}

main();
