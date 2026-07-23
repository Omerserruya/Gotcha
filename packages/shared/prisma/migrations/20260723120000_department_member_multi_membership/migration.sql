-- Multi-department membership: a user may belong to several departments.
-- The (user_id, department_id) pair-unique constraint remains, so duplicates
-- are still impossible. No data changes - existing single memberships are
-- already valid multi-membership rows.
DROP INDEX IF EXISTS "department_members_user_id_key";
-- Ensure the pair-unique constraint exists (some environments predate it).
CREATE UNIQUE INDEX IF NOT EXISTS "department_members_user_id_department_id_key" ON "department_members"("user_id", "department_id");
