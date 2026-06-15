/**
 * Intelligence Registry - Customer Intelligence V2, Phase 1.
 *
 * The scope-aware field registry (`FieldDefinition`) + Industry Pack catalog
 * (`IntelligencePack`). Replaces the flat `PostConversationConfig.summaryFields`
 * as the canonical schema for what intelligence GOTCHA tracks per tenant.
 *
 * Each FieldDefinition declares the SCOPE it owns
 * (customer | opportunity | conversation) - the core anti-overwrite mechanic
 * (see docs/customer-intelligence-domain-model.md §4.4 / §5).
 *
 * Phase 1 = define + store + CRUD only. The summarizer / live extractor do not
 * yet read this registry at runtime (later phases). The legacy
 * PostConversationConfig path is intentionally left untouched (no regression).
 */

import { prisma } from "@chatcenter/shared";

// ── Public DTO shapes (frontend-friendly, lowercase) ──
export type FieldScope = "customer" | "opportunity" | "conversation";
export type FieldTypeName = "text" | "number" | "boolean" | "enum" | "date" | "entity_ref";
export type FieldOriginName = "pack" | "custom" | "discovered";

export interface FieldDefinitionDTO {
  id: string;
  key: string;
  label: string;
  description?: string | null;
  type: FieldTypeName;
  scope: FieldScope;
  options: string[];
  required: boolean;
  stageRelevance: string[];
  aiExtract: boolean;
  syncToCrm: boolean;
  crmFieldMap?: Record<string, unknown> | null;
  origin: FieldOriginName;
  packSlug?: string | null;
}

export interface PackDTO {
  id: string;
  slug: string;
  name: string;
  version: number;
  isSystem: boolean;
  fields: PackFieldTemplate[];
}

export interface PackFieldTemplate {
  key: string;
  label: string;
  type: FieldTypeName;
  scope: FieldScope;
  options?: string[];
  required?: boolean;
  stageRelevance?: string[];
  aiExtract?: boolean;
  syncToCrm?: boolean;
}

// ── Enum <-> string mapping (Prisma enums are UPPERCASE) ──
const TYPE_TO_PRISMA: Record<FieldTypeName, string> = {
  text: "TEXT", number: "NUMBER", boolean: "BOOLEAN",
  enum: "ENUM", date: "DATE", entity_ref: "ENTITY_REF",
};
const SCOPE_TO_PRISMA: Record<FieldScope, string> = {
  customer: "CUSTOMER", opportunity: "OPPORTUNITY", conversation: "CONVERSATION",
};
const ORIGIN_TO_PRISMA: Record<FieldOriginName, string> = {
  pack: "PACK", custom: "CUSTOM", discovered: "DISCOVERED",
};

export const FIELD_TYPES: FieldTypeName[] = ["text", "number", "boolean", "enum", "date", "entity_ref"];
export const FIELD_SCOPES: FieldScope[] = ["customer", "opportunity", "conversation"];

function typeFromPrisma(v: string): FieldTypeName {
  return (v?.toLowerCase() as FieldTypeName) ?? "text";
}
function scopeFromPrisma(v: string): FieldScope {
  return (v?.toLowerCase() as FieldScope) ?? "opportunity";
}
function originFromPrisma(v: string): FieldOriginName {
  return (v?.toLowerCase() as FieldOriginName) ?? "custom";
}

function toFieldDTO(row: any): FieldDefinitionDTO {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description ?? null,
    type: typeFromPrisma(row.type),
    scope: scopeFromPrisma(row.scope),
    options: Array.isArray(row.options) ? row.options : [],
    required: !!row.required,
    stageRelevance: Array.isArray(row.stageRelevance) ? row.stageRelevance : [],
    aiExtract: row.aiExtract !== false,
    syncToCrm: row.syncToCrm !== false,
    crmFieldMap: (row.crmFieldMap as Record<string, unknown>) ?? null,
    origin: originFromPrisma(row.origin),
    packSlug: row.packSlug ?? null,
  };
}

function toPackDTO(row: any): PackDTO {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    version: row.version ?? 1,
    isSystem: !!row.isSystem,
    fields: Array.isArray(row.fields) ? (row.fields as PackFieldTemplate[]) : [],
  };
}

// ── Validation ──
const KEY_RE = /^[a-z][a-z0-9_]*$/;

export function normalizeKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface FieldInput {
  key: string;
  label: string;
  description?: string | null;
  type?: FieldTypeName;
  scope?: FieldScope;
  options?: string[];
  required?: boolean;
  stageRelevance?: string[];
  aiExtract?: boolean;
  syncToCrm?: boolean;
  crmFieldMap?: Record<string, unknown> | null;
  origin?: FieldOriginName;
  packSlug?: string | null;
}

export function validateFieldInput(
  input: Partial<FieldInput>,
  { partial = false }: { partial?: boolean } = {},
): { ok: true; value: FieldInput } | { ok: false; error: string } {
  const out: any = {};

  if (input.key !== undefined || !partial) {
    const key = normalizeKey(input.key);
    if (!KEY_RE.test(key)) {
      return { ok: false, error: "key must be snake_case (a-z, 0-9, _) starting with a letter" };
    }
    out.key = key;
  }
  if (input.label !== undefined || !partial) {
    const label = String(input.label ?? "").trim();
    if (!label) return { ok: false, error: "label is required" };
    out.label = label;
  }
  if (input.type !== undefined) {
    if (!FIELD_TYPES.includes(input.type)) return { ok: false, error: `type must be one of ${FIELD_TYPES.join(", ")}` };
    out.type = input.type;
  }
  if (input.scope !== undefined) {
    if (!FIELD_SCOPES.includes(input.scope)) return { ok: false, error: `scope must be one of ${FIELD_SCOPES.join(", ")}` };
    out.scope = input.scope;
  }
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.some((o) => typeof o !== "string")) {
      return { ok: false, error: "options must be a string array" };
    }
    out.options = input.options.map((o) => o.trim()).filter(Boolean);
  }
  // enum type must carry at least one option (when type is being set)
  const effType = out.type ?? input.type;
  if (effType === "enum") {
    const opts = out.options ?? input.options;
    if (!opts || opts.length === 0) return { ok: false, error: "enum fields require at least one option" };
  }
  if (input.description !== undefined) out.description = input.description === null ? null : String(input.description);
  if (input.required !== undefined) out.required = !!input.required;
  if (input.stageRelevance !== undefined) {
    if (!Array.isArray(input.stageRelevance)) return { ok: false, error: "stageRelevance must be an array" };
    out.stageRelevance = input.stageRelevance.map((s) => String(s));
  }
  if (input.aiExtract !== undefined) out.aiExtract = !!input.aiExtract;
  if (input.syncToCrm !== undefined) out.syncToCrm = !!input.syncToCrm;
  if (input.crmFieldMap !== undefined) out.crmFieldMap = input.crmFieldMap;
  if (input.origin !== undefined) out.origin = input.origin;
  if (input.packSlug !== undefined) out.packSlug = input.packSlug;

  return { ok: true, value: out as FieldInput };
}

function toPrismaWrite(value: Partial<FieldInput>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (value.key !== undefined) data.key = value.key;
  if (value.label !== undefined) data.label = value.label;
  if (value.description !== undefined) data.description = value.description;
  if (value.type !== undefined) data.type = TYPE_TO_PRISMA[value.type] as any;
  if (value.scope !== undefined) data.scope = SCOPE_TO_PRISMA[value.scope] as any;
  if (value.options !== undefined) data.options = value.options as any;
  if (value.required !== undefined) data.required = value.required;
  if (value.stageRelevance !== undefined) data.stageRelevance = value.stageRelevance as any;
  if (value.aiExtract !== undefined) data.aiExtract = value.aiExtract;
  if (value.syncToCrm !== undefined) data.syncToCrm = value.syncToCrm;
  if (value.crmFieldMap !== undefined) data.crmFieldMap = value.crmFieldMap as any;
  if (value.origin !== undefined) data.origin = ORIGIN_TO_PRISMA[value.origin] as any;
  if (value.packSlug !== undefined) data.packSlug = value.packSlug;
  return data;
}

// ── Packs ──
export async function listPacks(tenantId: string): Promise<PackDTO[]> {
  const rows = await prisma.intelligencePack.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }] },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return rows.map(toPackDTO);
}

export interface ApplyPackResult {
  applied: string[];   // field keys created/updated from the pack
  skipped: string[];   // keys skipped because a tenant CUSTOM field owns them
  pack: PackDTO;
}

/**
 * Apply a pack: clone its scope-tagged field templates into per-tenant
 * FieldDefinition rows (origin=PACK), and set BusinessProfile.packSlug.
 *
 * Merge semantics (does not replace): an existing key owned by a tenant
 * CUSTOM/DISCOVERED field is left untouched (pack defaults never clobber
 * tenant work). An existing PACK field with the same key is refreshed.
 */
export async function applyPack(tenantId: string, slug: string): Promise<ApplyPackResult | null> {
  const pack = await prisma.intelligencePack.findFirst({
    where: { slug, OR: [{ tenantId: null }, { tenantId }] },
    orderBy: { tenantId: "asc" }, // prefer tenant-owned clone if present, else system
  });
  if (!pack) return null;

  const templates = (Array.isArray(pack.fields) ? pack.fields : []) as unknown as PackFieldTemplate[];
  const existing = await prisma.fieldDefinition.findMany({
    where: { tenantId },
    select: { key: true, origin: true },
  });
  const byKey = new Map(existing.map((e: any) => [e.key, e.origin as string]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const t of templates) {
    const key = normalizeKey(t.key);
    if (!KEY_RE.test(key)) continue;
    const owner = byKey.get(key);
    if (owner && owner !== "PACK") {
      // a tenant custom/discovered field owns this key - never clobber
      skipped.push(key);
      continue;
    }
    const validated = validateFieldInput(
      {
        key,
        label: t.label,
        type: t.type ?? "text",
        scope: t.scope ?? "opportunity",
        options: t.options ?? [],
        required: t.required ?? false,
        stageRelevance: t.stageRelevance ?? [],
        aiExtract: t.aiExtract ?? true,
        syncToCrm: t.syncToCrm ?? true,
        origin: "pack",
        packSlug: pack.slug,
      },
      { partial: false },
    );
    if (!validated.ok) { skipped.push(key); continue; }
    const data = toPrismaWrite(validated.value);
    await prisma.fieldDefinition.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: data as any,
      create: { tenantId, ...(data as any) },
    });
    applied.push(key);
  }

  await prisma.businessProfile.updateMany({
    where: { tenantId },
    data: { packSlug: pack.slug },
  });

  return { applied, skipped, pack: toPackDTO(pack) };
}

// ── FieldDefinition CRUD ──
export async function listFields(tenantId: string, scope?: FieldScope): Promise<FieldDefinitionDTO[]> {
  const rows = await prisma.fieldDefinition.findMany({
    where: { tenantId, ...(scope ? { scope: SCOPE_TO_PRISMA[scope] as any } : {}) },
    orderBy: [{ origin: "asc" }, { label: "asc" }],
  });
  return rows.map(toFieldDTO);
}

export async function getField(tenantId: string, id: string): Promise<FieldDefinitionDTO | null> {
  const row = await prisma.fieldDefinition.findFirst({ where: { id, tenantId } });
  return row ? toFieldDTO(row) : null;
}

export async function createField(tenantId: string, input: FieldInput): Promise<FieldDefinitionDTO> {
  const data = toPrismaWrite({
    type: "text",
    scope: "opportunity",
    origin: "custom",
    ...input,
  });
  const row = await prisma.fieldDefinition.create({ data: { tenantId, ...(data as any) } });
  return toFieldDTO(row);
}

export async function updateField(
  tenantId: string,
  id: string,
  patch: Partial<FieldInput>,
): Promise<FieldDefinitionDTO | null> {
  const owned = await prisma.fieldDefinition.findFirst({ where: { id, tenantId } });
  if (!owned) return null;
  const data = toPrismaWrite(patch);
  const row = await prisma.fieldDefinition.update({ where: { id }, data: data as any });
  return toFieldDTO(row);
}

export async function deleteField(tenantId: string, id: string): Promise<boolean> {
  const owned = await prisma.fieldDefinition.findFirst({ where: { id, tenantId } });
  if (!owned) return false;
  await prisma.fieldDefinition.delete({ where: { id } });
  return true;
}

export async function keyExists(tenantId: string, key: string, exceptId?: string): Promise<boolean> {
  const row = await prisma.fieldDefinition.findFirst({
    where: { tenantId, key, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  return !!row;
}
