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

    /**
     * The payment capabilities are ON for the suite, and OFF everywhere else.
     *
     * They default off in production because a payment capability that switches
     * itself on eventually takes someone's money by accident. But most of what
     * is worth testing here IS the charging path - declines, ambiguous
     * outcomes, double-charge prevention - so a suite that inherited the
     * production default would test almost nothing.
     *
     * Safe because ICOUNT_MODE stays mock/simulator: neither reaches the
     * network, so "charging enabled" here means exercising the code, not moving
     * money. The off state has its own tests rather than being the accidental
     * state of every other test - see capability-switches.test.ts.
     */
    env: {
      ICOUNT_CHECKOUT_ENABLED: "true",
      ICOUNT_TOKENIZATION_ENABLED: "true",
      ICOUNT_STORED_CARD_CHARGE_ENABLED: "true",
    },
  },
});
