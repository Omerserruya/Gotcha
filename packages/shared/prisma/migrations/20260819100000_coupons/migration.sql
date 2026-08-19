-- Coupons: sysadmin-issued recurring discounts on an existing price.
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');
CREATE TYPE "TenantCouponStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_he" TEXT,
    "discount_type" "CouponDiscountType" NOT NULL,
    "percent_off" INTEGER,
    "amount_off" DECIMAL(12,2),
    "currency" TEXT,
    "default_duration_months" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "max_redemptions" INTEGER,
    "redemption_count" INTEGER NOT NULL DEFAULT 0,
    "internal_note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
CREATE INDEX "coupons_active_idx" ON "coupons"("active");

CREATE TABLE "tenant_coupons" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3),
    "status" "TenantCouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_by" TEXT,
    "note" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenant_coupons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_coupons_tenant_id_status_idx" ON "tenant_coupons"("tenant_id", "status");
CREATE INDEX "tenant_coupons_status_ends_at_idx" ON "tenant_coupons"("status", "ends_at");

ALTER TABLE "tenant_coupons" ADD CONSTRAINT "tenant_coupons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_coupons" ADD CONSTRAINT "tenant_coupons_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a charge would have been, and what the coupon took off.
ALTER TABLE "charges" ADD COLUMN "list_amount" DECIMAL(12,2);
ALTER TABLE "charges" ADD COLUMN "discount_amount" DECIMAL(12,2);
ALTER TABLE "charges" ADD COLUMN "coupon_code" TEXT;
