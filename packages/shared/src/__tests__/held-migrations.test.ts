/**
 * ★ Two drops wait for a full rebuild (Omer, 2026-10-07), and they must not
 * be in prisma/migrations until then: `prisma migrate deploy` runs whatever is
 * there, and an image built before the field left the schema still selects it
 * (each image bakes its own client). They sat in migrations/ with only a SQL
 * comment saying "wait", which migrate deploy ignores (found 2026-10-09).
 *
 * This fails if either drop is back in migrations/ while its GATE.md still
 * says it is parked. Promoting one means updating its GATE.md with the release
 * that rebuilt every image.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const PRISMA = path.resolve(__dirname, "../../prisma");
const HELD = [
  { name: "drop_channel_response_mode", drops: /DROP COLUMN\s+"response_mode"/i },
  { name: "drop_ai_agent_channels", drops: /ALTER TABLE\s+"ai_agents"\s+DROP COLUMN\s+"channels"/i },
];

function migrationSqls(): Array<{ dir: string; sql: string }> {
  const root = path.join(PRISMA, "migrations");
  return fs.readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, "migration.sql")))
    .map((d) => ({ dir: d, sql: fs.readFileSync(path.join(root, d, "migration.sql"), "utf8") }));
}

describe("★ held drops stay out of prisma/migrations until their gate", () => {
  for (const h of HELD) {
    it(`${h.name}: parked in migrations-pending, and no migration in migrations/ performs it`, () => {
      const gate = fs.readFileSync(path.join(PRISMA, "migrations-pending", h.name, "GATE.md"), "utf8");
      const parked = /\*\*Status:\*\* parked/.test(gate);
      const inMigrations = migrationSqls().filter((m) => h.drops.test(m.sql)).map((m) => m.dir);
      if (parked) expect(inMigrations).toEqual([]);
      expect(fs.existsSync(path.join(PRISMA, "migrations-pending", h.name, "migration.sql"))).toBe(parked);
    });
  }
});
