/**
 * Read every HTTP route out of the source and emit a machine-readable inventory.
 *
 * This exists because the alternative is a hand-written OpenAPI file, and a
 * hand-written spec for 700+ Express routes is wrong within a week: nothing
 * fails when a route is added, renamed, or has its auth changed, so the
 * document drifts silently and quietly becomes a liability. Deriving it from
 * the source means the spec can be regenerated, and disagreement between the
 * two becomes a diff instead of a surprise.
 *
 * It parses real TypeScript ASTs rather than grepping. Route files carry
 * middleware chains, router-level `router.use(...)` that applies to everything
 * declared below it, and Zod schemas referenced by identifier - none of which a
 * regex reads correctly, and all of which decide what the documentation says
 * about authentication.
 *
 * READ-ONLY. Nothing here imports application code or touches a database; it
 * only reads files. Run it with:  npx tsx scripts/api-docs/extract-routes.ts
 */
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");

// ─── Types ──────────────────────────────────────────────────

export interface RouteAuth {
  authenticate: boolean;
  resolveTenant: boolean;
  /** requireActiveTenant() / requireOnboardingOrActiveTenant() */
  tenantState: string | null;
  roles: string[];
  permissions: string[];
  /** requirePermissionOrRole("perm", "ROLE") - either satisfies it. */
  permissionOrRole: Array<{ permission: string; role: string }>;
  features: string[];
  capacity: string[];
  /** Shared-secret service-to-service auth rather than a user token. */
  internal: boolean;
  /** requireSystemAdmin / requirePlatformAdmin - platform staff, not tenant users. */
  adminGates: string[];
  /** Named permission helpers: canReadSystems, requirePlatformPermission, ... */
  permissionGates: string[];
  /** enforceMfaEnrollment - the caller must have MFA set up. */
  mfaRequired: boolean;
  /** crossTenantMiddleware - deliberately spans tenants. */
  crossTenant: boolean;
  entitlements: string[];
  /** optionalAuth - identifies the caller when a token is present, else anonymous. */
  optionalAuth: boolean;
  /** Webhook signature verification stands in for a user token. */
  signatureVerified: boolean;
  /** Rate limiter middleware applied to this route. */
  rateLimiters: string[];
  /** Middleware we saw but do not classify, kept so nothing is silently lost. */
  other: string[];
}

export interface RouteRecord {
  service: string;
  /** Path as mounted inside the service, e.g. /api/conversations/:id/messages */
  path: string;
  method: string;
  /** Public path through the gateway, when the prefix is exposed. */
  publicPath: string | null;
  exposedPublicly: boolean;
  file: string;
  line: number;
  auth: RouteAuth;
  /** Identifier passed to validate(...), when present. */
  requestSchemaName: string | null;
  requestSchema: JsonSchema | null;
  pathParams: string[];
  queryParams: string[];
  /** Status codes the handler can return, read from res.status(...) calls. */
  statusCodes: number[];
  /** true for GET/HEAD. */
  readOnly: boolean;
  multipart: boolean;
  /** Leading `//` comment above the route, used as the description. */
  comment: string | null;
  handlerName: string | null;
  /** Prisma models touched, and how. */
  dbOps: Array<{ model: string; op: string }>;
  /** Queue / external / event side effects detected in the handler body. */
  sideEffects: string[];
  serviceCalls: string[];
}

export type JsonSchema = Record<string, any>;

// ─── Gateway map ────────────────────────────────────────────

/**
 * Which public path prefixes nginx forwards, and to which service.
 * Read from the template so a new location block shows up here automatically.
 */
function readGatewayMap(): Array<{ prefix: string; service: string }> {
  const file = path.join(REPO_ROOT, "gateway/nginx.prod.conf.template");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const out: Array<{ prefix: string; service: string }> = [];
  const re = /location\s+([^\s{]+)\s*\{([\s\S]*?)\n\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const prefix = m[1];
    const body = m[2];
    const target = /proxy_pass\s+https?:\/\/([a-z0-9-]+)(?::\d+)?/i.exec(body);
    if (target) out.push({ prefix, service: target[1] });
  }
  return out;
}

// ─── AST helpers ────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function literal(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function calleeName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const obj = ts.isIdentifier(node.expression) ? node.expression.text : "";
    return obj ? `${obj}.${node.name.text}` : node.name.text;
  }
  return null;
}

/** The `//` or `/** *\/` comment immediately above a node, cleaned up. */
function leadingComment(sf: ts.SourceFile, node: ts.Node): string | null {
  const ranges = ts.getLeadingCommentRanges(sf.getFullText(), node.getFullStart());
  if (!ranges?.length) return null;
  const raw = sf.getFullText().slice(ranges[0].pos, ranges[ranges.length - 1].end);
  const cleaned = raw
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, "").trimEnd())
    // Drop the box-drawing section banners this codebase uses to group routes
    // ("─── Profile ─────"). They name a section, not an endpoint, and using
    // one as a purpose produces a description that is confidently about the
    // wrong thing.
    .filter((l) => !l.includes("───"))
    .map((l) => l.replace(/\*\/\s*$/, "").trimEnd())
    .join("\n")
    .trim();
  return cleaned || null;
}

// ─── Zod → JSON Schema ──────────────────────────────────────

/**
 * Convert the Zod expressions this codebase actually uses.
 *
 * Deliberately partial: an unrecognised validator degrades to `{}` with a note
 * rather than guessing a type. A spec that says "string" about something it did
 * not understand is worse than one that admits it does not know.
 */
function zodToJsonSchema(node: ts.Expression): JsonSchema {
  let cur: ts.Expression = node;
  const chain: Array<{ name: string; args: ts.NodeArray<ts.Expression> }> = [];

  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    chain.unshift({ name: cur.expression.name.text, args: cur.arguments });
    cur = cur.expression.expression;
  }
  // `cur` is now `z` (or the base identifier).
  if (chain.length === 0) return {};

  const base = chain.shift()!;
  let schema: JsonSchema = {};

  switch (base.name) {
    case "object": {
      schema = { type: "object", properties: {}, required: [] as string[] };
      const arg = base.args[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : null;
          if (!key) continue;
          const child = zodToJsonSchema(prop.initializer as ts.Expression);
          const optional = child.__optional === true;
          delete child.__optional;
          schema.properties[key] = child;
          if (!optional) schema.required.push(key);
        }
      }
      if (schema.required.length === 0) delete schema.required;
      break;
    }
    case "string":
      schema = { type: "string" };
      break;
    case "number":
      schema = { type: "number" };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "array": {
      const inner = base.args[0] ? zodToJsonSchema(base.args[0] as ts.Expression) : {};
      delete inner.__optional;
      schema = { type: "array", items: inner };
      break;
    }
    case "enum": {
      const arg = base.args[0];
      const values: string[] = [];
      if (arg && ts.isArrayLiteralExpression(arg)) {
        for (const el of arg.elements) {
          const v = literal(el);
          if (v !== null) values.push(v);
        }
      }
      schema = { type: "string", enum: values };
      break;
    }
    case "literal": {
      const v = literal(base.args[0]);
      schema = v !== null ? { const: v } : {};
      break;
    }
    case "record":
      schema = { type: "object", additionalProperties: true };
      break;
    case "any":
    case "unknown":
      schema = {};
      break;
    case "coerce":
      // z.coerce.number() etc - the next link carries the real type.
      schema = {};
      break;
    default:
      schema = { "x-zod": base.name };
  }

  for (const link of chain) {
    switch (link.name) {
      case "optional":
        schema.__optional = true;
        break;
      case "nullable":
        schema.nullable = true;
        break;
      case "default": {
        const d = link.args[0];
        schema.__optional = true;
        if (d) {
          const v = literal(d);
          if (v !== null) schema.default = v;
          else if (d.kind === ts.SyntaxKind.TrueKeyword) schema.default = true;
          else if (d.kind === ts.SyntaxKind.FalseKeyword) schema.default = false;
          else if (ts.isNumericLiteral(d)) schema.default = Number(d.text);
        }
        break;
      }
      case "min": {
        const n = link.args[0];
        if (n && ts.isNumericLiteral(n)) {
          if (schema.type === "string") schema.minLength = Number(n.text);
          else if (schema.type === "array") schema.minItems = Number(n.text);
          else schema.minimum = Number(n.text);
        }
        break;
      }
      case "max": {
        const n = link.args[0];
        if (n && ts.isNumericLiteral(n)) {
          if (schema.type === "string") schema.maxLength = Number(n.text);
          else if (schema.type === "array") schema.maxItems = Number(n.text);
          else schema.maximum = Number(n.text);
        }
        break;
      }
      case "email":
        schema.format = "email";
        break;
      case "url":
        schema.format = "uri";
        break;
      case "uuid":
        schema.format = "uuid";
        break;
      case "datetime":
        schema.format = "date-time";
        break;
      case "int":
        schema.type = "integer";
        break;
      case "number":
        schema.type = "number";
        break;
      case "string":
        schema.type = "string";
        break;
      case "boolean":
        schema.type = "boolean";
        break;
      case "positive":
        schema.exclusiveMinimum = 0;
        break;
      case "nonempty":
        schema.minItems = 1;
        break;
      case "describe": {
        const d = literal(link.args[0]);
        if (d) schema.description = d;
        break;
      }
      default:
        break; // refine/superRefine/transform carry no shape we can express
    }
  }

  return schema;
}

// ─── Middleware classification ──────────────────────────────

function emptyAuth(): RouteAuth {
  return {
    authenticate: false,
    resolveTenant: false,
    tenantState: null,
    roles: [],
    permissions: [],
    permissionOrRole: [],
    features: [],
    capacity: [],
    internal: false,
    adminGates: [],
    permissionGates: [],
    mfaRequired: false,
    crossTenant: false,
    entitlements: [],
    optionalAuth: false,
    signatureVerified: false,
    rateLimiters: [],
    other: [],
  };
}

function mergeAuth(base: RouteAuth, add: RouteAuth): RouteAuth {
  return {
    authenticate: base.authenticate || add.authenticate,
    resolveTenant: base.resolveTenant || add.resolveTenant,
    tenantState: add.tenantState ?? base.tenantState,
    roles: [...new Set([...base.roles, ...add.roles])],
    permissions: [...new Set([...base.permissions, ...add.permissions])],
    permissionOrRole: [...base.permissionOrRole, ...add.permissionOrRole],
    features: [...new Set([...base.features, ...add.features])],
    capacity: [...new Set([...base.capacity, ...add.capacity])],
    internal: base.internal || add.internal,
    adminGates: [...new Set([...base.adminGates, ...add.adminGates])],
    permissionGates: [...new Set([...base.permissionGates, ...add.permissionGates])],
    mfaRequired: base.mfaRequired || add.mfaRequired,
    crossTenant: base.crossTenant || add.crossTenant,
    entitlements: [...new Set([...base.entitlements, ...add.entitlements])],
    optionalAuth: base.optionalAuth || add.optionalAuth,
    signatureVerified: base.signatureVerified || add.signatureVerified,
    rateLimiters: [...new Set([...base.rateLimiters, ...add.rateLimiters])],
    other: [...new Set([...base.other, ...add.other])],
  };
}

/**
 * Classify a middleware name that is not one of the core helpers.
 *
 * Every one of these was found in the source by enumerating what the extractor
 * could not name. Leaving them unclassified made 23 admin-only routes read as
 * unauthenticated, so the catch-all branch is treated as a bug to be closed
 * rather than an acceptable default.
 */
function classifyNamed(auth: RouteAuth, name: string, args: readonly ts.Expression[]): void {
  const a0 = literal(args[0]);
  if (/^require(System|Platform)Admin$/.test(name)) { auth.adminGates.push(name); return; }
  if (name === "requirePlatformPermission") {
    auth.permissionGates.push(a0 ? `${name}(${a0})` : name); return;
  }
  if (name === "enforceMfaEnrollment") { auth.mfaRequired = true; return; }
  if (name === "crossTenantMiddleware") { auth.crossTenant = true; return; }
  if (name === "optionalAuth") { auth.optionalAuth = true; return; }
  if (/^verifySignature/.test(name)) { auth.signatureVerified = true; return; }
  if (name === "requireEntitlement") { auth.entitlements.push(a0 ?? "unknown"); return; }
  if (name === "requireChannelCapacity") { auth.capacity.push("limit:channels"); return; }
  if (/Limiter$/.test(name)) { auth.rateLimiters.push(name); return; }
  if (/^(can[A-Z]\w*|requireDepartmentRole|requirePaymentSetupAccess|writeGuard|voiceCopilotGate)$/.test(name)) {
    auth.permissionGates.push(a0 ? `${name}(${a0})` : name); return;
  }
  if (/^express\./.test(name)) return; // body parsers are not authorization
  auth.other.push(name);
}

/**
 * Resolve middleware, expanding `...ADMIN_ONLY` style spreads.
 *
 * Several route files hoist their chain into a const array and spread it:
 * `router.get("/users", ...ADMIN_ONLY, handler)`. Treating a SpreadElement as
 * unclassifiable makes those routes look UNAUTHENTICATED, which is the single
 * most dangerous thing this generator could get wrong - it would publish a
 * document telling a reader that an admin-only endpoint is open.
 */
function classifyMiddleware(
  args: readonly ts.Expression[],
  arrays: Map<string, ts.Expression[]> = new Map(),
): {
  auth: RouteAuth;
  schemaName: string | null;
  multipart: boolean;
} {
  const auth = emptyAuth();
  let schemaName: string | null = null;
  let multipart = false;

  const expanded: ts.Expression[] = [];
  for (const a of args) {
    if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression)) {
      const members = arrays.get(a.expression.text);
      if (members) { expanded.push(...members); continue; }
      // A spread we cannot resolve is recorded rather than ignored, so it is
      // visible in the output instead of silently reading as "no auth".
      auth.other.push(`...${a.expression.text} (unresolved)`);
      continue;
    }
    expanded.push(a);
  }

  for (const arg of expanded) {
    // Bare identifier: `authenticate`, `resolveTenant`, ...
    if (ts.isIdentifier(arg)) {
      const n = arg.text;
      if (n === "authenticate") auth.authenticate = true;
      else if (n === "resolveTenant") auth.resolveTenant = true;
      else if (/internal/i.test(n)) auth.internal = true;
      else if (n !== "asyncHandler") classifyNamed(auth, n, []);
      continue;
    }
    if (!ts.isCallExpression(arg)) continue;

    const name = calleeName(arg.expression);
    if (!name) continue;
    const a0 = literal(arg.arguments[0]);
    const a1 = literal(arg.arguments[1]);

    switch (name) {
      case "requireRole":
        for (const x of arg.arguments) {
          const v = literal(x);
          if (v) auth.roles.push(v);
        }
        break;
      case "requirePermission":
        for (const x of arg.arguments) {
          const v = literal(x);
          if (v) auth.permissions.push(v);
        }
        break;
      case "requirePermissionOrRole":
        if (a0 && a1) auth.permissionOrRole.push({ permission: a0, role: a1 });
        break;
      case "requireActiveTenant":
        auth.tenantState = "ACTIVE";
        break;
      case "requireOnboardingOrActiveTenant":
        auth.tenantState = "PENDING_ONBOARDING or ACTIVE";
        break;
      case "requireFeature":
        auth.features.push(
          a0 ?? (ts.isPropertyAccessExpression(arg.arguments[0] as any)
            ? (arg.arguments[0] as ts.PropertyAccessExpression).name.text
            : "unknown"),
        );
        break;
      case "requireCapacity":
        if (a0) auth.capacity.push(a0);
        break;
      case "validate":
        if (arg.arguments[0] && ts.isIdentifier(arg.arguments[0])) {
          schemaName = (arg.arguments[0] as ts.Identifier).text;
        }
        break;
      case "upload.single":
      case "upload.array":
      case "upload.fields":
        multipart = true;
        break;
      default:
        classifyNamed(auth, name, arg.arguments);
    }
  }

  return { auth, schemaName, multipart };
}

// ─── Handler body analysis ──────────────────────────────────

const PRISMA_WRITE = new Set([
  "create", "createMany", "update", "updateMany", "upsert",
  "delete", "deleteMany", "$executeRaw", "$transaction",
]);

/** What the handler actually does: DB ops, queues, outbound calls, services. */
function analyzeHandler(node: ts.Node): {
  dbOps: Array<{ model: string; op: string }>;
  sideEffects: string[];
  serviceCalls: string[];
  statusCodes: number[];
  queryParams: string[];
} {
  const dbOps: Array<{ model: string; op: string }> = [];
  const sideEffects = new Set<string>();
  const serviceCalls = new Set<string>();
  const statusCodes = new Set<number>();
  const queryParams = new Set<string>();

  const visit = (n: ts.Node): void => {
    // prisma.<model>.<op>(...)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const outer = n.expression;
      if (ts.isPropertyAccessExpression(outer.expression)) {
        const root = outer.expression.expression;
        if (ts.isIdentifier(root) && (root.text === "prisma" || root.text === "tx")) {
          dbOps.push({ model: outer.name.text, op: outer.name.text ? outer.name.text : "" });
          // outer.name is the MODEL; n.expression.name is the op.
          dbOps[dbOps.length - 1] = { model: outer.name.text, op: outer.name.text };
        }
      }
      const full = calleeName(n.expression);
      if (full) {
        // prisma.x.y() reads as "prisma.x" here; recover model+op properly.
        const parts = n.expression.getText().split(".");
        if (parts.length >= 3 && (parts[0] === "prisma" || parts[0] === "tx")) {
          dbOps[dbOps.length - 1] = { model: parts[1], op: parts[2] };
        }
        if (/Queue\.add$/.test(full)) sideEffects.add(`queue: ${full}`);
        if (/^publishEvent$/.test(full)) sideEffects.add("event: publishEvent");
        if (/^logAudit$|auditLog\.create/.test(full)) sideEffects.add("audit log write");
        if (/^fetch$/.test(full)) sideEffects.add("outbound HTTP (fetch)");
        if (/^axios\.(get|post|put|patch|delete)$/.test(full)) sideEffects.add(`outbound HTTP (${full})`);
        if (/Service\./.test(full) || /^[a-z][A-Za-z]*Service$/.test(full.split(".")[0] ?? "")) {
          serviceCalls.add(full);
        }
        if (/^res\.status$/.test(full)) {
          const arg = n.arguments[0];
          if (arg && ts.isNumericLiteral(arg)) statusCodes.add(Number(arg.text));
        }
      }
    }
    // req.query.<name>
    if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const t = n.expression.getText();
      if (t === "req.query") queryParams.add(n.name.text);
    }
    if (ts.isElementAccessExpression(n) && n.expression.getText() === "req.query") {
      const v = literal(n.argumentExpression);
      if (v) queryParams.add(v);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);

  // Deduplicate DB ops and drop malformed entries.
  const seen = new Set<string>();
  const cleanDb = dbOps
    .filter((d) => d.model && d.op && d.model !== d.op)
    .filter((d) => {
      const k = `${d.model}.${d.op}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return {
    dbOps: cleanDb,
    sideEffects: [...sideEffects],
    serviceCalls: [...serviceCalls],
    statusCodes: [...statusCodes].sort((a, b) => a - b),
    queryParams: [...queryParams],
  };
}

// ─── Route file walking ─────────────────────────────────────

function pathParamsOf(p: string): string[] {
  return [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function joinPath(prefix: string, sub: string): string {
  const a = prefix.replace(/\/$/, "");
  const b = sub === "/" ? "" : sub;
  return (a + b) || "/";
}

function extractFromRouteFile(
  file: string,
  mountPrefix: string,
  service: string,
): RouteRecord[] {
  const sf = parse(file);
  const records: RouteRecord[] = [];

  // Middleware arrays hoisted to file scope, e.g.
  // `const ADMIN_ONLY = [authenticate, resolveTenant, requireRole("ADMIN")]`.
  const mwArrays = new Map<string, ts.Expression[]>();
  const collectArrays = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isArrayLiteralExpression(n.initializer)
    ) {
      const els = n.initializer.elements.filter((e): e is ts.Expression => !ts.isSpreadElement(e));
      const looksLikeMiddleware = els.some((e) => {
        const t = e.getText();
        return /^(authenticate|resolveTenant|require[A-Z]|validate\()/.test(t);
      });
      if (looksLikeMiddleware) mwArrays.set(n.name.text, [...n.initializer.elements] as ts.Expression[]);
    }
    ts.forEachChild(n, collectArrays);
  };
  collectArrays(sf);

  // Zod schemas declared in this file, by identifier.
  const schemas = new Map<string, JsonSchema>();
  const collectSchemas = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (init.getText().startsWith("z.")) {
        const s = zodToJsonSchema(init);
        delete s.__optional;
        schemas.set(n.name.text, s);
      }
    }
    ts.forEachChild(n, collectSchemas);
  };
  collectSchemas(sf);

  // router.use(...) applies to everything declared AFTER it, so walk in order.
  let ambient = emptyAuth();
  // router.use("/funnels", authenticate, ...) applies only to paths under that
  // prefix. Several AI-service routers mount many resources on one `/api` and
  // scope their auth chain this way; ignoring the path form made every one of
  // those routes read as anonymous.
  const scoped: Array<{ prefix: string; auth: RouteAuth }> = [];

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      const method = n.expression.name.text.toLowerCase();
      const isRouter = ts.isIdentifier(obj) && (obj.text === "router" || obj.text === "app");

      if (isRouter && method === "use") {
        const scopePath = literal(n.arguments[0]);
        if (scopePath) {
          const a = classifyMiddleware(n.arguments.slice(1), mwArrays).auth;
          scoped.push({ prefix: scopePath, auth: a });
        } else {
          ambient = mergeAuth(ambient, classifyMiddleware(n.arguments, mwArrays).auth);
        }
      } else if (isRouter && ["get", "post", "put", "patch", "delete"].includes(method)) {
        const rawPath = literal(n.arguments[0]);
        // Array-form paths: router.get(["/a","/b"], ...)
        const paths: string[] = [];
        if (rawPath !== null) paths.push(rawPath);
        else if (n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
          for (const el of (n.arguments[0] as ts.ArrayLiteralExpression).elements) {
            const v = literal(el);
            if (v) paths.push(v);
          }
        }
        if (paths.length) {
          const middleware = n.arguments.slice(1);
          const { auth: routeAuth, schemaName, multipart } = classifyMiddleware(middleware, mwArrays);

          const handler = middleware[middleware.length - 1];
          const analysis = handler ? analyzeHandler(handler) : {
            dbOps: [], sideEffects: [], serviceCalls: [], statusCodes: [], queryParams: [],
          };

          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          const comment = leadingComment(sf, ts.isExpressionStatement(n.parent) ? n.parent : n);

          for (const p of paths) {
            const full = joinPath(mountPrefix, p);
            // Apply any path-scoped router.use() whose prefix covers this route.
            let auth = ambient;
            for (const sc of scoped) {
              if (p === sc.prefix || p.startsWith(sc.prefix.replace(/\/$/, "") + "/")) {
                auth = mergeAuth(auth, sc.auth);
              }
            }
            auth = mergeAuth(auth, routeAuth);
            records.push({
              service,
              path: full,
              method: method.toUpperCase(),
              publicPath: null,
              exposedPublicly: false,
              file: path.relative(REPO_ROOT, file),
              line: line + 1,
              auth,
              requestSchemaName: schemaName,
              requestSchema: schemaName ? schemas.get(schemaName) ?? null : null,
              pathParams: pathParamsOf(full),
              queryParams: analysis.queryParams,
              statusCodes: analysis.statusCodes,
              readOnly: method === "get",
              multipart,
              comment,
              handlerName: null,
              dbOps: analysis.dbOps,
              sideEffects: analysis.sideEffects,
              serviceCalls: analysis.serviceCalls,
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return records;
}

// ─── Service index walking ──────────────────────────────────

/** Map a router identifier to the file it was imported from. */
function importMap(sf: ts.SourceFile, serviceDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = literal(st.moduleSpecifier);
    if (!spec || !spec.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(sf.fileName), spec);
    const candidates = [`${resolved}.ts`, path.join(resolved, "index.ts")];
    const file = candidates.find((c) => fs.existsSync(c));
    if (!file) continue;
    const clause = st.importClause;
    if (clause?.name) map.set(clause.name.text, file);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) map.set(el.name.text, file);
    }
  }
  return map;
}

function extractService(serviceDir: string): RouteRecord[] {
  // Most services register routes in index.ts; voice-copilot uses an app.ts
  // factory instead. Both are read, because a service whose routes are simply
  // missing from the inventory is the most dangerous kind of documentation gap:
  // it looks complete.
  const candidates = ["src/index.ts", "src/app.ts"].map((f) => path.join(serviceDir, f));
  const entries = candidates.filter((f) => fs.existsSync(f));
  if (entries.length === 0) return [];
  const service = path.basename(serviceDir);
  return entries.flatMap((entry) => extractFromEntry(entry, serviceDir, service));
}

function extractFromEntry(indexFile: string, serviceDir: string, service: string): RouteRecord[] {
  const sf = parse(indexFile);
  const imports = importMap(sf, serviceDir);
  const out: RouteRecord[] = [];
  const seenMounts = new Set<string>();

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "app" &&
      n.expression.name.text === "use"
    ) {
      const prefix = literal(n.arguments[0]);
      if (prefix) {
        for (const arg of n.arguments.slice(1)) {
          // Either a router identifier, or a factory call like
          // `createLiveRouter({...})` which voice-copilot uses throughout.
          let ident: string | null = null;
          if (ts.isIdentifier(arg)) ident = arg.text;
          else if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) ident = arg.expression.text;
          if (!ident) continue;
          const file = imports.get(ident);
          if (!file) continue; // rate limiters etc, not routers
          const key = `${prefix}::${file}`;
          if (seenMounts.has(key)) continue;
          seenMounts.add(key);
          out.push(...extractFromRouteFile(file, prefix, service));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ─── Public exposure ────────────────────────────────────────

function markPublicExposure(records: RouteRecord[]): void {
  const gateway = readGatewayMap();
  // `location /` is the SPA catch-all and `/_next/static/` is the bundle; both
  // match every API path and would mark the entire surface "public". Exposure
  // has to mean a real API prefix or the flag says nothing.
  const apiPrefixes = gateway.filter(
    (g) => g.prefix !== "/" && !g.prefix.startsWith("/_next") && g.prefix !== "/health",
  );
  // Longest prefix wins, so /api/admin/billing beats /api/admin.
  const sorted = [...apiPrefixes].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const r of records) {
    const hit = sorted.find(
      (g) => r.path === g.prefix || r.path.startsWith(g.prefix.replace(/\/$/, "") + "/"),
    );
    if (hit) {
      r.exposedPublicly = true;
      r.publicPath = r.path;
    }
  }
}

// ─── Exclusions ─────────────────────────────────────────────

/**
 * Routes that are not business API surface.
 *
 * Health probes, readiness checks and debug scaffolding describe the runtime,
 * not the product, and documenting them invites someone to depend on them.
 */
const EXCLUDE = [
  /^\/health/, /^\/healthz/, /^\/ready/, /^\/metrics/,
  /^\/api\/ai-debug/, /\/debug(\/|$)/, /\/__test/, /\/test-/,
];

function isBusinessRoute(r: RouteRecord): boolean {
  return !EXCLUDE.some((re) => re.test(r.path));
}

// ─── Main ───────────────────────────────────────────────────

function main(): void {
  const servicesDir = path.join(REPO_ROOT, "services");
  const services = fs
    .readdirSync(servicesDir)
    .map((d) => path.join(servicesDir, d))
    .filter((d) => fs.statSync(d).isDirectory());

  let all: RouteRecord[] = [];
  for (const dir of services) all.push(...extractService(dir));

  markPublicExposure(all);

  const excluded = all.filter((r) => !isBusinessRoute(r));
  all = all.filter(isBusinessRoute);

  all.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const outDir = path.join(REPO_ROOT, "docs/.api-extract");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "route-inventory.json");
  fs.writeFileSync(outFile, JSON.stringify({ generatedFrom: "source AST", routes: all }, null, 2));

  // Summary to stderr so it never pollutes piped output.
  const byService = new Map<string, number>();
  for (const r of all) byService.set(r.service, (byService.get(r.service) ?? 0) + 1);
  console.error(`routes extracted : ${all.length}`);
  console.error(`excluded (health/debug): ${excluded.length}`);
  console.error(`publicly exposed : ${all.filter((r) => r.exposedPublicly).length}`);
  console.error(`with Zod schema  : ${all.filter((r) => r.requestSchema).length}`);
  console.error(`authenticated    : ${all.filter((r) => r.auth.authenticate).length}`);
  for (const [s, n] of [...byService].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${s.padEnd(18)} ${n}`);
  }
  console.error(`\nwrote ${path.relative(REPO_ROOT, outFile)}`);
}

main();
