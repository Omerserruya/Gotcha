-- AlterEnum: Add SYSTEM_ADMIN to Role
ALTER TYPE "Role" ADD VALUE 'SYSTEM_ADMIN';

-- AlterTable: Add is_active to tenants
ALTER TABLE "tenants" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
