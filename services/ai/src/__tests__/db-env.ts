/**
 * Make DATABASE_URL available to database-backed tests run from the host.
 *
 * The repo's .env points at `db:5432`, which is the docker network DNS name -
 * correct inside a container, unresolvable from the host where vitest runs. So
 * a test that imports prisma dies at client init with "Environment variable not
 * found: DATABASE_URL" unless the caller happens to export one.
 *
 * That failure mode is worse than it looks: the test file fails to COLLECT, so
 * every case in it reports as skipped. An enforcement test that quietly stops
 * running is the exact thing it exists to prevent.
 *
 * Import this BEFORE anything that pulls in prisma - ES module imports evaluate
 * in order, and the Prisma client reads the environment when it is constructed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(join(__dirname, "../../../../.env"), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
    if (line) {
      // The docker service name only resolves inside the compose network; the
      // same postgres is published on the host loopback.
      process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).trim().replace("@db:", "@localhost:");
    }
  } catch {
    // Leave it unset. The test will fail loudly on connect, which is the
    // honest outcome - better than passing without touching a database.
  }
}

export const DATABASE_AVAILABLE = !!process.env.DATABASE_URL;
