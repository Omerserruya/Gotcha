#!/usr/bin/env node
/**
 * Create the FIRST GOTCHA account, so somebody can log in at all.
 *
 * GOTCHA deliberately does not provision itself from a token. Authentik owns
 * authentication; authorization - who exists, in which tenant, with what role -
 * is 100% local (CLAUDE.md rule 7). resolvePrincipal() therefore refuses a
 * perfectly valid token when no local Identity carries its subject:
 *
 *     throw new AuthError("No GOTCHA account is linked to this identity", "no_account");
 *
 * That is correct, and it is also a chicken-and-egg on a fresh install: every
 * route that could create the first tenant sits behind the gate that needs it.
 * The public onboarding router only ACCEPTS invitations, which presupposes a
 * tenant that can send one. So the first account is an operational step, and
 * this is it. Everyone after them arrives by invitation.
 *
 * Idempotent: every row is upserted on its natural key (tenants.slug,
 * identities.email, users(tenant_id, identity_id)), so re-running repairs a
 * partial run instead of duplicating one.
 *
 * Usage:
 *   node scripts/authentik/bootstrap-first-admin.mjs --target prod --dry-run
 *   node scripts/authentik/bootstrap-first-admin.mjs --target prod
 *
 * Reads AUTHENTIK_PUBLIC_API (or AUTHENTIK_URL) and AUTHENTIK_BOOTSTRAP_TOKEN.
 */
import { makeRunner } from "../billing/plan-transport.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const TARGET = opt("target", "prod");
const DRY_RUN = flag("dry-run");
const BASE = (process.env.AUTHENTIK_PUBLIC_API || process.env.AUTHENTIK_URL || "").replace(/\/$/, "");
const TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN || process.env.AUTHENTIK_API_TOKEN;
const EMAIL = opt("email", process.env.AUTHENTIK_BOOTSTRAP_EMAIL);
const APP_SLUG = process.env.AUTHENTIK_APP_SLUG || "gotcha";
const TENANT_NAME = opt("tenant-name", "System");
const TENANT_SLUG = opt("tenant-slug", "system");
const ROLE = opt("role", "SYSTEM_ADMIN");

if (!BASE) throw new Error("AUTHENTIK_PUBLIC_API (or AUTHENTIK_URL) is required - use the PUBLIC url");
if (!TOKEN) throw new Error("AUTHENTIK_BOOTSTRAP_TOKEN is required");
if (!EMAIL) throw new Error("--email or AUTHENTIK_BOOTSTRAP_EMAIL is required");

async function ak(path) {
  const res = await fetch(`${BASE}/api/v3${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Single-quote a value for SQL. Everything here is operator input, not user input. */
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

// ── 1. Who are we linking? ─────────────────────────────────────────────────
const users = await ak(`/core/users/?email=${encodeURIComponent(EMAIL)}`);
const user = users.results?.[0];
if (!user) throw new Error(`No Authentik user with email ${EMAIL} - create them there first`);

// ── 2. Does `sub` actually mean what we are about to store? ────────────────
// The identity is joined to Authentik by `authentik_subject`, matched against
// the `sub` claim. Which value Authentik puts in `sub` is a PROVIDER setting.
// Writing the uuid while the provider emits an email produces a row that looks
// correct in every dump and never matches a single token - a silent, permanent
// "no_account" for a user who plainly exists. Refuse instead of guessing.
const providers = await ak("/providers/oauth2/");
const provider = providers.results?.find((p) => p.name === "gotcha-oidc") ?? providers.results?.[0];
if (!provider) throw new Error("No OAuth2 provider found - run bootstrap.mjs first");
if (provider.sub_mode !== "user_uuid") {
  throw new Error(
    `provider sub_mode is "${provider.sub_mode}", expected "user_uuid". ` +
    `The subject stored here must be the exact value Authentik puts in the token's \`sub\`.`,
  );
}
const subject = user.uuid;
if (!subject) throw new Error("Authentik user has no uuid");

const name = user.name || EMAIL;

console.log(`  authentik      ${BASE}`);
console.log(`  user           ${user.username} <${EMAIL}> (pk=${user.pk})`);
console.log(`  sub_mode       ${provider.sub_mode}  ->  subject ${subject}`);
console.log(`  tenant         ${TENANT_NAME} (${TENANT_SLUG})`);
console.log(`  role           ${ROLE}`);
console.log(`  target         ${TARGET}${DRY_RUN ? "  [DRY RUN]" : ""}`);

// ── 3. Upsert tenant -> identity -> membership, atomically ─────────────────
// One statement, CTE-chained, so a failure anywhere leaves nothing behind.
// gen_random_uuid()::text: Prisma generates cuids in the client, and these
// columns carry no database-side default, so the id must be supplied here.
const sql = `
BEGIN;

WITH t AS (
  INSERT INTO tenants (id, name, slug, status, is_active, created_at, updated_at)
  VALUES (gen_random_uuid()::text, ${q(TENANT_NAME)}, ${q(TENANT_SLUG)}, 'PENDING_ADMIN_SETUP', true, now(), now())
  ON CONFLICT (slug) DO UPDATE SET updated_at = now()
  RETURNING id
), i AS (
  INSERT INTO identities (id, email, name, authentik_subject, session_version, created_at, updated_at)
  VALUES (gen_random_uuid()::text, ${q(EMAIL)}, ${q(name)}, ${q(subject)}, 0, now(), now())
  -- Re-running must REPAIR the link, not skip it: an identity created before
  -- the provider existed would otherwise keep a null subject forever.
  ON CONFLICT (email) DO UPDATE SET authentik_subject = EXCLUDED.authentik_subject, updated_at = now()
  RETURNING id
)
INSERT INTO users (id, tenant_id, identity_id, email, name, role, is_active, created_at, updated_at)
SELECT gen_random_uuid()::text, t.id, i.id, ${q(EMAIL)}, ${q(name)}, ${q(ROLE)}::"Role", true, now(), now()
FROM t, i
ON CONFLICT (tenant_id, identity_id) DO UPDATE SET role = EXCLUDED.role, is_active = true, updated_at = now();

\\echo '=== resulting account ==='
SELECT i.email, i.authentik_subject, u.role::text, t.name AS tenant, t.slug, u.is_active
  FROM identities i
  JOIN users u ON u.identity_id = i.id
  JOIN tenants t ON t.id = u.tenant_id
 WHERE i.email = ${q(EMAIL)};

${DRY_RUN ? "ROLLBACK;" : "COMMIT;"}
`;

const runner = makeRunner(TARGET);
console.log(`\n  running against ${runner.label}\n`);
console.log(runner.sql(sql));
console.log(DRY_RUN ? "  DRY RUN - rolled back, nothing was written.\n" : "  Committed.\n");
