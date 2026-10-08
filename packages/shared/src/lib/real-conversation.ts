/**
 * What a conversation has to be to count as the business's real traffic.
 *
 * BOTH HALVES ARE REQUIRED; `isTest` ALONE DOES NOTHING USEFUL. Sandbox
 * conversations (the AI-employee rehearsals a team runs during setup) are
 * written with `isTest = false`, so filtering on that flag alone lets every
 * one of them through. The external-id prefix is the product's own definition
 * of a sandbox conversation (`sandbox-conversation.service.ts`).
 *
 * Imported history needs nothing here: `applyLiveByDefault` (lib/prisma.ts)
 * adds `origin: "LIVE"` to every conversation and message query. Raw SQL is
 * not covered by that guard and must say `origin = 'LIVE'` itself.
 *
 * Spread it into a where clause; put a visibility OR inside an AND, never
 * beside it (two ORs in one object overwrite each other).
 */
export const REAL_CONVERSATION = {
  isTest: false,
  NOT: { customerExternalId: { startsWith: "sandbox:" } },
} as const;
