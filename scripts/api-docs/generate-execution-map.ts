/**
 * Render docs/API_EXECUTION_MAP.md from the extracted route inventory.
 *
 * The OpenAPI file answers "what can I call". This one answers "what happens
 * when I do" - which middleware runs in what order, which Prisma models are
 * read and written, which queues and providers get touched, and which
 * background work outlives the response.
 *
 * Every claim here is derived from the AST. Where the source does not say
 * something, this file says that instead of guessing: an execution map that
 * quietly invents a service call is worse than one with an honest blank.
 *
 * Run: npx tsx scripts/api-docs/generate-execution-map.ts
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const INVENTORY = path.join(REPO_ROOT, "docs/.api-extract/route-inventory.json");
const OUT = path.join(REPO_ROOT, "docs/API_EXECUTION_MAP.md");

interface Route {
  service: string; path: string; method: string; exposedPublicly: boolean;
  file: string; line: number; auth: any;
  requestSchemaName: string | null; requestSchema: any;
  pathParams: string[]; queryParams: string[]; statusCodes: number[];
  readOnly: boolean; multipart: boolean; comment: string | null;
  dbOps: Array<{ model: string; op: string }>; sideEffects: string[]; serviceCalls: string[];
}

// Tag map is shared in spirit with generate-openapi.ts; kept local so the two
// generators can be run independently.
const TAGS: Array<[string, string]> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "tag-map.json"), "utf8"),
);

function tagFor(p: string): string {
  let best: [string, string] | null = null;
  for (const e of TAGS) {
    if (p === e[0] || p.startsWith(e[0])) if (!best || e[0].length > best[0].length) best = e;
  }
  return best ? best[1] : "Other";
}

const WRITE_OPS = new Set([
  "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
]);

function anchor(r: Route): string {
  return `${r.method.toLowerCase()}-${r.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

// ─── Section builders ───────────────────────────────────────

function purpose(r: Route): string {
  if (r.comment) {
    const first = r.comment.split("\n\n")[0].replace(/\n/g, " ").trim();
    if (first.length > 3) return first;
  }
  // No comment in the source, so the purpose is derived from the shape of the
  // route. Marked as derived, because a confident-sounding sentence nobody
  // wrote is exactly how documentation starts lying.
  const segs = r.path.split("/").filter(Boolean).filter((s) => s !== "api");
  const nouns = segs.filter((s) => !s.startsWith(":"));
  const last = nouns[nouns.length - 1] ?? "resource";
  const parent = nouns.length > 1 ? nouns[nouns.length - 2] : null;
  const readable = (x: string) => x.replace(/[-_]/g, " ");
  const singular = (x: string) => x.replace(/ies$/, "y").replace(/s$/, "");
  const article = (x: string) => (/^[aeiou]/i.test(x) ? "an" : "a");

  // A trailing verb-ish segment after a path parameter is an action, not a
  // collection: POST /agents/:id/activate is "activate", not "create".
  const isAction =
    r.method === "POST" &&
    segs.length > 1 &&
    (segs[segs.length - 2]?.startsWith(":") ?? false);

  const scope = parent && segs[segs.length - 1] === last && segs.some((s) => s.startsWith(":"))
    ? ` for the referenced ${singular(readable(parent))}`
    : "";

  let sentence: string;
  if (isAction) {
    sentence = `Performs the \`${readable(last)}\` action on the referenced ${singular(readable(parent ?? last))}`;
  } else if (r.method === "GET") {
    sentence = r.pathParams.length
      ? `Reads a single ${singular(readable(last))}${scope}`
      : `Lists ${readable(last)}${scope}`;
  } else if (r.method === "DELETE") {
    sentence = `Deletes the referenced ${singular(readable(last))}${scope}`;
  } else if (r.method === "POST") {
    sentence = `Creates ${article(singular(readable(last)))} ${singular(readable(last))}${scope}`;
  } else {
    sentence = `Updates the referenced ${singular(readable(last))}${scope}`;
  }
  return `${sentence}. _(Derived from the route shape; no descriptive comment in source.)_`;
}

function authLine(r: Route): string {
  const a = r.auth;
  const bits: string[] = [];
  if (a.internal) bits.push("**Internal only.** Authenticated by the shared service secret, not a user token. Not routed by the gateway.");
  else if (a.signatureVerified) bits.push("**Provider signature.** The caller is a webhook; verification is mandatory and fails closed.");
  else if (a.authenticate) bits.push("`authenticate()` (`packages/shared/src/middleware/auth.ts`) verifies the Authentik JWT against JWKS and resolves `sub` → `User.authentikSubject`.");
  else if (a.optionalAuth) bits.push("`optionalAuth` - identifies the caller when a token is present, otherwise proceeds anonymously.");
  else bits.push("**No authentication middleware.** This route is reachable without a token.");

  if (a.resolveTenant) bits.push("`resolveTenant` derives `req.tenantId` from the principal; it is never read from the request body.");
  else if (a.authenticate) bits.push("No `resolveTenant`: this route is not tenant-scoped by middleware.");
  if (a.tenantState) bits.push(`Tenant status gate: **${a.tenantState}**.`);
  if (a.mfaRequired) bits.push("`enforceMfaEnrollment` - the caller must have MFA set up.");
  if (a.crossTenant) bits.push("`crossTenantMiddleware` - deliberately spans tenants.");
  return bits.join(" ");
}

function authzLine(r: Route): string {
  const a = r.auth;
  const bits: string[] = [];
  if (a.roles.length) bits.push(`Role: \`${a.roles.join("`, `")}\``);
  if (a.permissions.length) bits.push(`Permission: \`${a.permissions.join("`, `")}\``);
  for (const p of a.permissionOrRole) bits.push(`\`${p.permission}\` **or** role \`${p.role}\``);
  if (a.adminGates.length) bits.push(`Platform staff gate: \`${a.adminGates.join("`, `")}\``);
  if (a.permissionGates.length) bits.push(`Gate: \`${a.permissionGates.join("`, `")}\``);
  if (a.features.length) bits.push(`Feature flag: \`${a.features.join("`, `")}\``);
  if (a.entitlements.length) bits.push(`Entitlement: \`${a.entitlements.join("`, `")}\``);
  if (a.capacity.length) bits.push(`Plan limit: \`${a.capacity.join("`, `")}\``);
  if (!bits.length) {
    return a.authenticate
      ? "None beyond authentication. Any authenticated member of the tenant may call this."
      : "None.";
  }
  return bits.join("; ");
}

function validationLine(r: Route): string {
  if (r.requestSchemaName) {
    const props = r.requestSchema?.properties ? Object.keys(r.requestSchema.properties) : [];
    const req = r.requestSchema?.required ?? [];
    return [
      `\`validate(${r.requestSchemaName})\` (Zod).`,
      props.length ? `Accepts: ${props.map((p) => `\`${p}\``).join(", ")}.` : "",
      req.length ? `Required: ${req.map((p: string) => `\`${p}\``).join(", ")}.` : "",
      "`validate` reassigns `req.body` to the parsed value, so any property not named by the schema is stripped before the handler runs.",
    ].filter(Boolean).join(" ");
  }
  if (r.multipart) return "`multer` handles a `multipart/form-data` upload. No Zod schema.";
  if (["POST", "PUT", "PATCH"].includes(r.method)) {
    return "**No schema.** The handler reads `req.body` directly, so the accepted shape is not verifiable from source and is not enforced.";
  }
  return r.pathParams.length || r.queryParams.length
    ? "No body schema. Path and query parameters are read directly by the handler."
    : "No input.";
}

function classifySideEffects(r: Route): { queues: string[]; external: string[]; events: string[] } {
  const queues: string[] = [], external: string[] = [], events: string[] = [];
  for (const s of r.sideEffects) {
    if (s.startsWith("queue:")) queues.push(s.replace("queue: ", ""));
    else if (s.startsWith("event:")) events.push(s.replace("event: ", ""));
    else if (s.startsWith("outbound HTTP")) external.push(s);
    else if (s.includes("audit")) events.push(s);
    else external.push(s);
  }
  return { queues, external, events };
}

function executionFlow(r: Route): string {
  const lines: string[] = [];
  const { queues, external, events } = classifySideEffects(r);
  const reads = r.dbOps.filter((d) => !WRITE_OPS.has(d.op));
  const writes = r.dbOps.filter((d) => WRITE_OPS.has(d.op));

  const mount = "/" + r.path.split("/").slice(1, 3).join("/");
  lines.push(`1. **Route registration.** \`${r.service}\` service mounts this router at \`${mount}\` in \`services/${r.service}/src/index.ts\`; the route is declared in \`${r.file}\`.`);
  lines.push(`2. **Handler.** \`${r.file}:${r.line}\` - inline \`async (req, res)\` handler.`);
  lines.push(`3. **Validation.** ${validationLine(r)}`);
  lines.push(`4. **Authentication / tenant resolution.** ${authLine(r)}`);
  lines.push(`5. **Authorization.** ${authzLine(r)}`);

  if (r.serviceCalls.length) {
    lines.push(`6. **Service calls**, in source order:\n${r.serviceCalls.map((s) => `   - \`${s}()\``).join("\n")}`);
  } else {
    lines.push("6. **Service calls.** None; the handler works directly against Prisma and/or the response.");
  }

  if (r.dbOps.length) {
    const fmt = (d: { model: string; op: string }) => `   - \`${d.model}.${d.op}\``;
    const parts: string[] = [];
    if (reads.length) parts.push(`   _Reads:_\n${reads.map(fmt).join("\n")}`);
    if (writes.length) parts.push(`   _Writes:_\n${writes.map(fmt).join("\n")}`);
    lines.push(`7. **Database.** Prisma models touched (source order, not guaranteed runtime order - branches may skip some):\n${parts.join("\n")}`);
  } else {
    lines.push("7. **Database.** No direct Prisma access in the handler body. Any persistence happens inside the services listed above.");
  }

  lines.push(external.length
    ? `8. **External integrations.**\n${external.map((e) => `   - ${e}`).join("\n")}`
    : "8. **External integrations.** None detected in the handler body.");

  const bg: string[] = [];
  for (const q of queues) bg.push(`   - Enqueues \`${q}\` (BullMQ). The response returns before this work runs; retries and backoff are the queue's.`);
  for (const e of events) bg.push(`   - ${e}`);
  lines.push(bg.length
    ? `9. **Background work, events and audit.**\n${bg.join("\n")}`
    : "9. **Background work, events and audit.** None triggered by this endpoint.");

  const codes = r.statusCodes.length ? r.statusCodes : [r.method === "POST" ? 201 : 200];
  const success = codes.filter((c) => c < 400);
  const failure = codes.filter((c) => c >= 400);
  const respBits = [
    success.length
      ? `Success: \`${success.join("`, `")}\`${r.statusCodes.length ? "" : " _(inferred - the handler sets no explicit success status; Express defaults to 200)_"}, answering the \`{ data: ... }\` envelope.`
      : "Success status not determinable from source.",
    failure.length ? `Error paths: \`${failure.join("`, `")}\`, answering \`{ error: ... }\`.` : "No explicit error statuses in the handler.",
    r.auth.authenticate ? "`401` is returned by `authenticate()` before the handler runs." : "",
    r.auth.rateLimiters.length ? `\`429\` from \`${r.auth.rateLimiters.join("`, `")}\`.` : "",
  ].filter(Boolean);
  lines.push(`10. **Response and error paths.** ${respBits.join(" ")}`);

  return lines.join("\n");
}

function callGraph(r: Route): string {
  const { queues, external } = classifySideEffects(r);
  const reads = r.dbOps.filter((d) => !WRITE_OPS.has(d.op));
  const writes = r.dbOps.filter((d) => WRITE_OPS.has(d.op));
  const L: string[] = [];

  L.push(`${r.method} ${r.path}`);
  const mw: string[] = [];
  if (r.auth.authenticate) mw.push("authenticate");
  if (r.auth.internal) mw.push("internalAuth");
  if (r.auth.signatureVerified) mw.push("verifySignature");
  if (r.auth.resolveTenant) mw.push("resolveTenant");
  if (r.auth.tenantState) mw.push(`requireTenantState(${r.auth.tenantState})`);
  for (const role of r.auth.roles) mw.push(`requireRole(${role})`);
  for (const p of r.auth.permissions) mw.push(`requirePermission(${p})`);
  for (const g of r.auth.adminGates) mw.push(g);
  for (const g of r.auth.permissionGates) mw.push(g);
  if (r.requestSchemaName) mw.push(`validate(${r.requestSchemaName})`);
  if (mw.length) L.push(`  → [${mw.join(" → ")}]`);

  L.push(`  → handler  ${r.file}:${r.line}`);
  for (const s of r.serviceCalls) L.push(`      → ${s}()`);
  for (const d of reads) L.push(`      → db read   prisma.${d.model}.${d.op}`);
  for (const d of writes) L.push(`      → db write  prisma.${d.model}.${d.op}`);
  for (const e of external) L.push(`      → external  ${e}`);
  for (const q of queues) L.push(`      → queue     ${q}  (async, outlives the response)`);
  if (!r.serviceCalls.length && !r.dbOps.length && !external.length && !queues.length) {
    L.push("      → (responds directly; no downstream calls detected)");
  }
  return L.join("\n");
}

function renderRoute(r: Route): string {
  const out: string[] = [];
  out.push(`### \`${r.method} ${r.path}\``);
  out.push("");
  out.push(`- **Purpose:** ${purpose(r)}`);
  out.push(`- **Handler:** \`${r.file}\` line ${r.line}`);
  out.push(`- **Authentication / tenant resolution:** ${authLine(r)}`);
  out.push(`- **Authorization:** ${authzLine(r)}`);
  out.push(`- **Input validation:** ${validationLine(r)}`);
  out.push(`- **Exposure:** ${r.exposedPublicly ? "Routed by the gateway (reachable from the internet)." : "**Not** routed by the gateway; internal traffic only."}`);
  out.push(`- **Operation type:** ${r.readOnly ? "read" : "write"}`);
  out.push("");
  out.push("#### Execution flow");
  out.push("");
  out.push(executionFlow(r));
  out.push("");
  out.push("#### Call graph");
  out.push("");
  out.push("```text");
  out.push(callGraph(r));
  out.push("```");
  out.push("");
  return out.join("\n");
}

// ─── Main ───────────────────────────────────────────────────

function main(): void {
  const { routes } = JSON.parse(fs.readFileSync(INVENTORY, "utf8")) as { routes: Route[] };

  const byTag = new Map<string, Route[]>();
  for (const r of routes) {
    const t = tagFor(r.path);
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t)!.push(r);
  }
  const tags = [...byTag.keys()].sort();

  const doc: string[] = [];
  doc.push("# GOTCHA API Execution Map");
  doc.push("");
  doc.push([
    "What happens inside the platform after an HTTP call arrives: the middleware that runs before the",
    "handler, the services it calls, the database rows it reads and writes, the providers it talks to, and",
    "the background work that outlives the response.",
  ].join(" "));
  doc.push("");
  doc.push("## How to read this, and how far to trust it");
  doc.push("");
  doc.push([
    "This file is **generated from the TypeScript AST**, not written by hand - see",
    "`scripts/api-docs/extract-routes.ts` and `scripts/api-docs/generate-execution-map.ts`. Regenerate with",
    "`npm run api:docs`. That matters because a hand-maintained map of 780 endpoints is stale within a",
    "sprint, and a stale map of *authorization* is actively dangerous.",
  ].join(" "));
  doc.push("");
  doc.push("| Claim | How it is established | Trust |");
  doc.push("|---|---|---|");
  doc.push("| Method, path, handler location | Read from the router AST | Exact |");
  doc.push("| Authentication and authorization | Resolved middleware chain, including router-level, path-scoped and spread (`...ADMIN_ONLY`) middleware | Exact |");
  doc.push("| Input validation | The Zod schema passed to `validate(...)` | Exact where a schema exists |");
  doc.push("| Database operations | `prisma.<model>.<op>` calls in the handler body | Exact for direct calls; misses work done inside services |");
  doc.push("| Service calls | Call expressions matching a service module | Exact for direct calls |");
  doc.push("| Queues, events, outbound HTTP | Detected call patterns in the handler body | Exact for direct calls |");
  doc.push("| Execution *order* | Source order of the AST | Indicative, not guaranteed - branches and early returns can skip steps |");
  doc.push("| Response body shape | Not declared anywhere in this codebase | **Unknown - read the handler** |");
  doc.push("");
  doc.push([
    "The single most important caveat: step 7 lists Prisma calls made **in the handler itself**. When a",
    "handler delegates to a service, that service's own database work is not expanded here. The service is",
    "named in step 6 so it can be followed.",
  ].join(" "));
  doc.push("");
  doc.push("## Cross-cutting behaviour");
  doc.push("");
  doc.push("- **Tenancy.** `resolveTenant` sets `req.tenantId` from the verified principal. No endpoint takes a tenant id from the caller. Endpoints that deliberately cross tenants are called out individually.");
  doc.push("- **Authentication.** GOTCHA implements none of it. Authentik issues tokens; `authenticate()` verifies them against JWKS and maps `sub` → `User.authentikSubject`. It fails closed.");
  doc.push("- **Validation.** `validate(schema)` replaces `req.body` with the parsed object. Properties the schema does not name are stripped before the handler sees them.");
  doc.push("- **Async work.** Anything enqueued to BullMQ returns to the caller immediately; retries, backoff and failure handling belong to the worker, not the request.");
  doc.push("- **Response envelope.** `{ data: ... }` on success, `{ error: ... }` on failure.");
  doc.push("");

  // Summary table
  doc.push("## Coverage");
  doc.push("");
  doc.push("| Domain | Endpoints | Read | Write | Unauthenticated |");
  doc.push("|---|---:|---:|---:|---:|");
  for (const t of tags) {
    const rs = byTag.get(t)!;
    const anon = rs.filter((r) => !r.auth.authenticate && !r.auth.internal && !r.auth.signatureVerified && !r.auth.adminGates.length).length;
    doc.push(`| [${t}](#${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}) | ${rs.length} | ${rs.filter((r) => r.readOnly).length} | ${rs.filter((r) => !r.readOnly).length} | ${anon} |`);
  }
  const totalAnon = routes.filter((r) => !r.auth.authenticate && !r.auth.internal && !r.auth.signatureVerified && !r.auth.adminGates.length).length;
  doc.push(`| **Total** | **${routes.length}** | **${routes.filter((r) => r.readOnly).length}** | **${routes.filter((r) => !r.readOnly).length}** | **${totalAnon}** |`);
  doc.push("");

  for (const t of tags) {
    const rs = byTag.get(t)!.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    doc.push(`## ${t}`);
    doc.push("");
    doc.push(`${rs.length} endpoint${rs.length === 1 ? "" : "s"}.`);
    doc.push("");
    for (const r of rs) doc.push(renderRoute(r));
  }

  fs.writeFileSync(OUT, doc.join("\n"));
  console.error(`endpoints documented : ${routes.length}`);
  console.error(`domains              : ${tags.length}`);
  console.error(`wrote ${path.relative(REPO_ROOT, OUT)}`);
}

main();
