#!/usr/bin/env node
/**
 * Provision Authentik identities for GOTCHA users that have none.
 *
 * Run once after the Authentik migration, and safe to re-run: users that
 * already carry an `authentik_subject` are skipped, and identity creation is
 * itself idempotent on email.
 *
 * A user row without a subject cannot authenticate at all - `authenticate()`
 * resolves tokens by subject, so an unlinked row is inert. This closes that
 * gap for anyone who existed before the migration.
 *
 * Usage:
 *   DATABASE_URL=... AUTHENTIK_URL=... AUTHENTIK_BOOTSTRAP_TOKEN=... \
 *   node scripts/authentik/link-existing-users.mjs [--send-links]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = (process.env.AUTHENTIK_URL || "http://localhost:9000").replace(/\/$/, "");
const TOKEN = process.env.AUTHENTIK_API_TOKEN || process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
const EMIT_LINKS = process.argv.includes("--send-links");

if (!TOKEN) {
  console.error("AUTHENTIK_BOOTSTRAP_TOKEN (or AUTHENTIK_API_TOKEN) is required");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(path, options = {}) {
  const res = await fetch(`${BASE}/api/v3${path}`, { ...options, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function ensureIdentity(email, name) {
  const found = await api(`/core/users/?email=${encodeURIComponent(email)}`);
  const hit = found.results?.find((u) => u.email === email);
  if (hit) return hit;
  return api("/core/users/", {
    method: "POST",
    body: JSON.stringify({ username: email, email, name, is_active: true, path: "users", type: "internal" }),
  });
}

async function main() {
  const users = await prisma.user.findMany({
    where: { authentikSubject: null },
    select: { id: true, email: true, name: true, role: true, tenantId: true },
  });

  console.log(`[link] ${users.length} user(s) need an identity`);

  for (const u of users) {
    try {
      const identity = await ensureIdentity(u.email, u.name);

      // Guard the unique constraint explicitly: two GOTCHA users in different
      // tenants can share an email, but they cannot share one subject.
      const clash = await prisma.user.findUnique({
        where: { authentikSubject: identity.uuid },
        select: { id: true, email: true },
      });
      if (clash && clash.id !== u.id) {
        console.log(`  SKIP ${u.email} - subject already linked to user ${clash.id}`);
        continue;
      }

      await prisma.user.update({
        where: { id: u.id },
        data: { authentikSubject: identity.uuid },
      });

      let link = "";
      if (EMIT_LINKS) {
        const r = await api(`/core/users/${identity.pk}/recovery/`, { method: "POST" });
        link = r.link;
      }
      console.log(`  OK   ${u.email} (${u.role}) -> ${identity.uuid}${link ? `\n       setup: ${link}` : ""}`);
    } catch (err) {
      console.error(`  FAIL ${u.email}: ${err.message}`);
    }
  }

  const remaining = await prisma.user.count({ where: { authentikSubject: null } });
  console.log(`[link] done. ${remaining} user(s) still unlinked.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FAILED:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
