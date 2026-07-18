-- Authentik migration: remove local authentication from GOTCHA.
--
-- After this migration the database physically cannot store a credential:
--   * users.password          - gone. Authentik owns passwords.
--   * refresh_tokens          - gone. Authentik owns session/refresh lifecycle.
--   * magic_links             - gone. Authentik owns recovery/invitation links.
--   * users.authentik_subject - added. The only link to an identity: Authentik's
--     immutable user UUID, which is the OIDC `sub` claim.
--
-- Deliberately scoped to authentication only. `prisma migrate diff` also
-- reports unrelated pre-existing drift in this database (foreign-key churn,
-- index renames, defaults on other tables). That drift is not this migration's
-- business - folding it in would make an auth change unreviewable.

-- AlterTable
ALTER TABLE "users" DROP COLUMN "password",
ADD COLUMN     "authentik_subject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_authentik_subject_key" ON "users"("authentik_subject");

-- DropTable
DROP TABLE "magic_links";

-- DropTable
DROP TABLE "refresh_tokens";
