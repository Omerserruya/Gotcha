# Phase 1 Implementation Spec — CIO Foundation + Industry Packs

> **Design only — no source edits.** Build-ready spec for Phase 1 of
> `docs/customer-intelligence-architecture.md`.
> **Goal:** promote `CustomerBrief` to the Customer Intelligence Object (CIO),
> add an Industry Pack catalog, wire onboarding business-type → pack, and ship a
> Fields Builder over the existing `summaryFields`.
> **Constraints:** no new service, no new deps, LLM-only-in-`services/ai`,
> UI + backend, sparse-patch + manual-wins preserved.

---

## 1. Scope (in / out)

**In:** schema extension; `IndustryPack` table + 4 seed packs; pack catalog API;
onboarding pack detection + confirm; Fields Builder UI over `PostConversationConfig.summaryFields`.

**Out (later phases):** live text extraction (P2), the card (P3), executive summary
& timeline (P4), CRM field-map (P5), Discovery Engine (P6). P1 only **defines and
stores** the structured shape — nothing reads/writes `universalFields`/`industryFields`
at runtime yet beyond CRUD.

---

## 2. Schema changes (`packages/shared/prisma/schema.prisma`)

> DB workflow: `npm run db:generate` then `npm run db:migrate` (per CLAUDE.md).
> All new columns are **nullable / defaulted** → safe additive migration, zero
> backfill required.

### 2.1 Extend `CustomerBrief` (model @ line 2754)

```prisma
// ── Customer Intelligence Object (structured) ──
universalFields   Json    @default("{}") @map("universal_fields")
industryFields    Json    @default("{}") @map("industry_fields")
executiveSummary  String? @map("executive_summary")
packId            String? @map("pack_id")
fieldConfidence   Json    @default("{}") @map("field_confidence")
intelligenceVersion Int   @default(0)    @map("intelligence_version")
```

No change to the `@@unique([tenantId, identityKey, locale])` key. **Convention
(documented, not enforced in P1):** structured fields live on the tenant's
default-locale row; prose stays per-locale.

### 2.2 New model `IndustryPack`

```prisma
model IndustryPack {
  id          String   @id @default(cuid())
  tenantId    String?  @map("tenant_id")   // null = system pack (shared)
  slug        String                        // "event_hall"
  name        String
  version     Int      @default(1)
  fields      Json     @default("[]")       // SummaryFieldDef[]
  defaultRules Json    @default("{}")        // { taskRules?, crmRules? }
  isSystem    Boolean  @default(false) @map("is_system")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([tenantId, slug])
  @@index([isSystem])
  @@map("industry_pack")
}
```

### 2.3 Extend `BusinessProfile` (model @ line 687)

```prisma
packSlug  String? @map("pack_slug")   // chosen industry pack
```

### 2.4 `SummaryFieldDef` flags (TypeScript, `post-conversation-config.service.ts`)

Add three optional fields (additive; `isSummaryFieldDef` still valid):

```ts
required?:  boolean;   // UI hint; not enforced server-side in P1
aiExtract?: boolean;   // default true — include key in allowedFields
syncToCrm?: boolean;   // default true — allow into crm_patch mapping (P5)
```

`getSummarizerAllowedFields` change: filter custom keys by `aiExtract !== false`
(builtins always included). No behavior change when flags absent.

---

## 3. Seed packs (`packages/shared/prisma/seed.ts`)

Insert 4 `isSystem` packs (tenantId null). Field defs reuse the existing
`SummaryFieldDef` shape.

| slug | fields (key:type) |
|---|---|
| `event_hall` | event_type:enum, event_date:text, event_time:text, guest_count:number, budget:number, kosher_level:enum[regular,mehadrin,badatz], outdoor_ceremony:boolean, parking_required:boolean, special_requests:text, bride_name:text, groom_name:text |
| `real_estate` | property_type:enum, rooms:number, budget:number, location:text, move_date:text, mortgage_required:boolean |
| `recruiting` | desired_position:text, expected_salary:number, availability:text, experience_years:number, security_clearance:boolean |
| `ecommerce` | order_number:text, order_status:enum, product:text, refund_requested:boolean, shipping_issue:boolean, delivery_date:text |

Seed is idempotent (upsert by `(null, slug)`).

---

## 4. API (extend existing `services/ai` routes)

### 4.1 Pack catalog (new, in a `routes/industry-packs.ts` mounted under existing prefix)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/industry-packs` | list system packs + tenant's cloned packs |
| POST | `/api/industry-packs/apply` | body `{ slug }` → clone pack `fields` into `PostConversationConfig.summaryFields`, set `BusinessProfile.packSlug` |

`apply` merges (does not replace) existing `summaryFields` by `key`
(dedupe; pack defaults don't clobber tenant custom fields). Uses existing
`setPostConversationConfig`.

### 4.2 Fields Builder (reuse existing config route)

`GET /` and `PUT /` on the post-conversation-config router already exist
(`routes/post-conversation-config.ts:27,44`). No new endpoint — the Fields Builder
UI reads/writes `summaryFields` through them. Validation extended for the 3 flags.

### 4.3 Gateway

Add `/api/industry-packs` to **both** nginx templates
(`gateway/nginx.prod.conf.template` + `nginx/nginx.conf.template`) — standard
ai-service prefix, no special buffering. (Per `project_ai_employee_readiness` note:
new AI routes must be covered in both templates.)

---

## 5. Onboarding wiring (`services/auth/src/routes/onboarding.ts`)

The website classifier (~line 1148) already returns
`{ name, industry, country, language, description }`. **Extend its JSON contract**
to also return `packSlug` (best match against the system pack slugs; empty if
none):

```
"packSlug": one of [event_hall, real_estate, recruiting, ecommerce] or "" if generic.
```

Add a confirm step in the onboarding domain phase:

```
Detected: Event Hall  →  Load the Event Hall pack (11 intelligence fields)?  [Approve] [Skip]
```

Approve → call `POST /api/industry-packs/apply { slug }`. Skip → generic
(universal fields only). Fully **skippable** (matches the onboarding "core system
now skippable" precedent and the AI-employee "asked-but-skippable" pattern).

---

## 6. Fields Builder UI (frontend, settings)

New settings page (or section): **Intelligence Fields**.

- Lists current `summaryFields` (from `GET` config) grouped: **From pack** vs **Custom**.
- Add/edit field form → `SummaryFieldDef` + `required` / `aiExtract` / `syncToCrm`
  toggles. Enum type reveals an options editor (chips).
- "Browse packs" → `GET /api/industry-packs` → apply.
- Save → `PUT` config. Optimistic update; toast on success.
- i18n (en/he) consistent with existing settings pages.

Mirror the in-wizard `StepRefine`/`KnowledgeModal` styling for consistency.

---

## 7. Migration & backward-compatibility

- All columns nullable/defaulted → **no backfill**; existing `CustomerBrief` rows
  keep working (`universalFields={}`, `industryFields={}`).
- Tenants with no pack applied behave exactly as today (empty `summaryFields`).
- `getSummarizerAllowedFields` unchanged for tenants without the new flags.
- Dev DB drift caveat (`project_dev_db_migration_drift`): after migrate, verify
  columns exist; read with explicit `select` where a row may predate migration.

---

## 8. Acceptance criteria

1. Migration applies cleanly; `prisma generate` types include new fields.
2. 4 system packs present after seed; `GET /api/industry-packs` returns them.
3. Onboarding classifier returns a `packSlug`; confirm step applies the pack and
   sets `BusinessProfile.packSlug`; Skip leaves config empty.
4. `apply` merges pack fields into `summaryFields` without clobbering custom keys.
5. Fields Builder: create an enum custom field with options, toggle
   `aiExtract`/`syncToCrm`, save, reload → persisted.
6. With `aiExtract=false`, the key is **absent** from `getSummarizerAllowedFields`.
7. No regression: existing post-conversation summarization/CRM sync unchanged for
   a tenant that skips packs.
8. Both nginx templates route `/api/industry-packs`.

---

## 9. Decisions needed before P1 build

1. **Locale storage** for structured fields — confirm "default-locale row holds
   structured; prose per-locale" (recommended) vs a dedicated `locale="*"` row.
2. **Pack apply = merge vs replace** when a tenant re-applies/switches packs
   (recommended: merge + mark pack-origin keys so a later "remove pack" is clean).
3. **Field-key namespacing** — allow pack and custom keys to collide? (recommended:
   reserve pack keys, suffix custom collisions).
4. Whether `required` is purely a UI hint in P1 or also gates readiness somewhere
   (recommended: UI-only in P1).

---

## 10. Estimated surface (files touched in P1)

- `packages/shared/prisma/schema.prisma` (+2 model edits, +1 model), `seed.ts`
- `services/ai/src/services/post-conversation-config.service.ts` (flags)
- `services/ai/src/routes/industry-packs.ts` (new), route mount in `index.ts`
- `services/auth/src/routes/onboarding.ts` (classifier contract + confirm step)
- `frontend/src/app/.../settings` Intelligence Fields page + API client fns
- `gateway/nginx.prod.conf.template`, `nginx/nginx.conf.template`
