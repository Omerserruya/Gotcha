import { defineConfig } from "vitest/config";

/**
 * Database-free unit tests only (no global setup/teardown, which sweeps rows in
 * the shared dev database). Run: npx vitest run -c vitest.unit.config.ts <file>
 */
export default defineConfig({
  test: { include: ["src/__tests__/monthly-credits.test.ts"] },
});
