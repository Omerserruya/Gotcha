import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Run test FILES one at a time.
     *
     * These suites are integration tests against the real database, and some of
     * them exercise state that is global by design - notably the single ACTIVE
     * billing exchange rate, which a partial unique index deliberately allows
     * only one of. Two files running concurrently retire each other's rate and
     * fail for reasons that have nothing to do with the code under test.
     *
     * Serial is the honest configuration here: the constraint being tested is a
     * real one, so the fix is to stop pretending these files are independent
     * rather than to weaken the constraint.
     */
    fileParallelism: false,
  },
});
