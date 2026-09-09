import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Sweep unowned billable entities this suite leaves behind.
     *
     * Three files here create BillableEntity rows (paid-access-gate,
     * enforcement-tenant-state, tenant-plan-access) and this package had no
     * vitest config, so nothing cleaned up after them. services/billing's
     * ownership guard counts unowned entities across the whole database, so it
     * was the thing that failed - over rows created by a different package.
     */
    globalSetup: ["./src/__tests__/global-teardown.ts"],
  },
});
