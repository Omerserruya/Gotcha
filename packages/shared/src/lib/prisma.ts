import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";

/**
 * Tenant-scoped models — every row in these tables belongs to a single
 * tenant. ANY query (read or mutate) must include a `tenantId` filter,
 * or the Prisma client extension below will refuse to run it.
 *
 * Rationale: Prisma silently drops `undefined` from WHERE clauses. Before
 * this guard, `prisma.knowledgeBase.findMany({ where: { tenantId: req.tenantId! } })`
 * returned ALL tenants' rows whenever `req.tenantId` was undefined (which
 * happened for some SYSTEM_ADMIN flows). That was a cross-tenant data
 * leak. This extension is the backstop: even if a handler forgets the
 * filter or passes undefined, the query throws instead of leaking.
 */
const TENANT_SCOPED_MODELS = new Set<string>([
  "AIAgent",
  "AgentScore",
  "AgentToolPermission",
  "AuditLog",
  "Broadcast",
  // BroadcastRecipient intentionally NOT guarded: the model has no tenantId
  // column (see schema.prisma). Isolation is transitive via broadcastId →
  // Broadcast.tenantId, enforced by every caller filtering on broadcastId.
  "BusinessPolicy",
  "ChannelAccount",
  "ChatbotFlow",
  "Contact",
  "Conversation",
  "CreditTransaction",
  "Department",
  "DepartmentMember",
  "FlowCanvas",
  "KnowledgeBase",
  "KnowledgeDocument",
  "KnowledgeIntegration",
  "MagicLink",
  "Message",
  "NotificationLog",
  "RouterRule",
  "ScheduledMessage",
  "SystemAgentMessage",
  "TenantIntegration",
  "TenantTool",
  "ToolExecution",
  "UsageLog",
  "User",
]);

/**
 * Escape hatch for deliberate cross-tenant queries (system-admin
 * aggregates across all tenants, maintenance scripts, etc.). Wrap the
 * query in `withCrossTenantAccess(async () => prisma.x.findMany({}))`
 * to temporarily disable the guard inside that async scope.
 *
 * Use sparingly and NEVER inside a route handler that serves a
 * non-admin user.
 */
const crossTenantContext = new AsyncLocalStorage<boolean>();

export function withCrossTenantAccess<T>(fn: () => Promise<T>): Promise<T> {
  return crossTenantContext.run(true, fn);
}

/**
 * Express middleware version: enables cross-tenant access for every
 * downstream handler in the same route. Mount at the top of a router
 * that is ALREADY guarded by `requireSystemAdmin()`. Everything the
 * route does afterwards (including async handlers) sees the guard
 * disabled.
 *
 *   router.use(authenticate, requireSystemAdmin(), crossTenantMiddleware);
 */
export function crossTenantMiddleware(_req: any, _res: any, next: any): void {
  crossTenantContext.run(true, () => next());
}

/**
 * BULK operations — they return or affect MANY rows. These are the
 * dangerous ones: a missing tenantId filter means "return everyone's
 * data" or "return the first match from any tenant". These MUST have
 * tenantId in their WHERE.
 */
const BULK_WHERE_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/**
 * SINGLE-ROW operations — inherently safe because they key by the
 * primary key (or a unique index) which is an unguessable cuid in this
 * schema. They never leak cross-tenant data on a guess. We allow them
 * without an explicit tenantId filter so workers/background jobs that
 * legitimately operate by ID don't need to be rewritten. The caller
 * is expected to have resolved ownership before calling them.
 */
const SINGLE_ROW_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
]);

/** Operations whose args shape has a top-level `data` object. */
const DATA_OPERATIONS = new Set(["create", "createMany", "upsert"]);

function hasTenantIdInWhere(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;
  if ("tenantId" in w && w.tenantId !== undefined) return true;
  // Compound unique-index selectors are nested one level under their
  // generated key, e.g. `where: { tenantId_channel_externalId: { tenantId,
  // channel, externalId } }`. Prisma exposes the compound index as a single
  // top-level field whose value is an object containing each component. We
  // accept it as guarded when the nested object itself includes tenantId.
  // Limited to one level deep on direct object values — this avoids false
  // positives from JSON-column filters like `where: { metadata: { equals: {
  // tenantId: "X" } } }`, which don't actually filter on tenant.
  for (const v of Object.values(w)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nv = v as Record<string, unknown>;
      if ("tenantId" in nv && nv.tenantId !== undefined) return true;
    }
  }
  // Nested AND/OR/NOT — walk the structure.
  for (const key of ["AND", "OR", "NOT"] as const) {
    const branch = w[key];
    if (Array.isArray(branch)) {
      if (branch.some((clause) => hasTenantIdInWhere(clause))) return true;
    } else if (branch && typeof branch === "object") {
      if (hasTenantIdInWhere(branch)) return true;
    }
  }
  return false;
}

function hasTenantIdInData(data: unknown): boolean {
  if (!data) return false;
  if (Array.isArray(data)) {
    return data.every((row) => hasTenantIdInData(row));
  }
  if (typeof data !== "object") return false;
  return "tenantId" in (data as Record<string, unknown>);
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof buildClient>;
};

function buildClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Not a tenant-scoped model → pass through.
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }
          // Opt-out via AsyncLocalStorage → pass through.
          if (crossTenantContext.getStore() === true) {
            return query(args);
          }
          // Single-row ops by primary key are inherently safe → pass through.
          if (SINGLE_ROW_OPERATIONS.has(operation)) {
            return query(args);
          }
          // Opt-out: raw SQL / transactions that don't go through models.
          if (!BULK_WHERE_OPERATIONS.has(operation) && !DATA_OPERATIONS.has(operation)) {
            return query(args);
          }

          if (DATA_OPERATIONS.has(operation)) {
            const data = (args as any)?.data;
            if (operation === "upsert") {
              const upsertArgs = args as any;
              if (!hasTenantIdInWhere(upsertArgs?.where)) {
                throw new Error(
                  `[TenantGuard] ${model}.upsert blocked: where clause must include tenantId`,
                );
              }
              if (!hasTenantIdInData(upsertArgs?.create)) {
                throw new Error(
                  `[TenantGuard] ${model}.upsert blocked: create payload must include tenantId`,
                );
              }
            } else if (!hasTenantIdInData(data)) {
              throw new Error(
                `[TenantGuard] ${model}.${operation} blocked: data payload must include tenantId`,
              );
            }
            return query(args);
          }

          // WHERE_OPERATIONS — require tenantId in the where clause.
          const where = (args as any)?.where;
          if (!hasTenantIdInWhere(where)) {
            throw new Error(
              `[TenantGuard] ${model}.${operation} blocked: where clause is missing tenantId. ` +
                `If this is an intentional cross-tenant query, wrap it in withCrossTenantAccess(() => ...).`,
            );
          }
          return query(args);
        },
      },
    },
  });
}

export const prisma: ReturnType<typeof buildClient> =
  globalForPrisma.prisma || buildClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
