-- Catalog HITL defaults: stop shipping high-risk tools as autonomous.
--
-- `catalog_tools.hitl_policy` is the SEED default. A tenant override in
-- `tenant_tools.config_overrides` is authoritative and wins, so this migration
-- CANNOT weaken a tenant's own decision - it only moves the floor for tenants
-- who never expressed one. That is also why the direction matters: every change
-- below is a TIGHTENING (never -> always). Nothing here turns an approval-gated
-- tool autonomous, and nothing re-enables a disabled one.
--
-- Why these tools
-- ---------------
-- The audit found 13 HIGH-risk tools, of which 2 shipped `never`, and a set of
-- MEDIUM tools whose defaults disagreed with near-identical siblings.
--
--   HIGH, must never default to autonomous:
--     returngo.update_transaction   mutates a returns/refund transaction
--     shopify.edit_order            rewrites a customer's existing order
--
--   Customer-visible sends - the customer receives an email either way, and an
--   AI sending one unprompted is not recoverable by undoing a DB row:
--     shopify.send_invoice
--     shopify.resend_confirmation
--
--   Revenue- or PII-affecting writes named in the audit:
--     shopify.disable_coupon        kills a live discount
--     shopify.update_customer       mutates customer PII
--     shopify.update_metafield      arbitrary customer metadata; it is in the
--                                   cross-customer guard's protected set
--     hubspot.create_deal           a deal is a revenue object; zoho_crm's
--                                   equivalent already required approval, so
--                                   this removes an inconsistency rather than
--                                   inventing a rule
--
--   Direct database writes whose own UPDATE sibling already required approval,
--   so INSERT being autonomous was an inconsistency, not a decision:
--     aws_rds.insert_row  (aws_rds.update_row      was already always)
--     mongodb.insert_document (mongodb.update_document was already always)
--     postgresql.insert_row   (postgresql.update_row   was already always)
--
-- Deliberately NOT changed
-- ------------------------
-- Record CREATION for CRM objects - create_lead, create_contact, create_case,
-- create_record, create_item, shopify.create_customer - stays autonomous where
-- it already is. Capturing a new lead is the core autonomous value of the
-- product, the record is additive rather than destructive, and requiring a
-- human for it would change what customers bought. Where a vendor already
-- required approval (all of zoho_crm), it is left alone: this migration never
-- loosens.
--
-- LOW-risk tagging, notes and segment membership also stay autonomous.
--
-- Idempotent: re-running is a no-op because each UPDATE is guarded on the
-- current value being exactly the old default.

-- ── Report BEFORE state (visible in migration logs) ─────────────────────────
DO $$
DECLARE n_high_never int; n_target int;
BEGIN
  SELECT count(*) INTO n_high_never
  FROM catalog_tools
  WHERE risk_level = 'HIGH' AND coalesce(hitl_policy->>'mode','never') = 'never';

  SELECT count(*) INTO n_target
  FROM catalog_tools t JOIN integration_catalog c ON c.id = t.integration_id
  WHERE coalesce(t.hitl_policy->>'mode','never') = 'never'
    AND (c.slug, t.slug) IN (
      ('returngo','update_transaction'), ('shopify','edit_order'),
      ('shopify','send_invoice'), ('shopify','resend_confirmation'),
      ('shopify','disable_coupon'), ('shopify','update_customer'),
      ('shopify','update_metafield'), ('hubspot','create_deal'),
      ('aws_rds','insert_row'), ('mongodb','insert_document'),
      ('postgresql','insert_row')
    );

  RAISE NOTICE '[tool-hitl] BEFORE: % HIGH-risk tools default to autonomous; % tools in scope for tightening',
    n_high_never, n_target;
END $$;

-- ── Tighten. Guarded on the old value, so re-running changes nothing. ───────
UPDATE catalog_tools t
SET hitl_policy = jsonb_build_object('mode', 'always')
FROM integration_catalog c
WHERE c.id = t.integration_id
  AND coalesce(t.hitl_policy->>'mode', 'never') = 'never'
  AND (c.slug, t.slug) IN (
    ('returngo','update_transaction'), ('shopify','edit_order'),
    ('shopify','send_invoice'), ('shopify','resend_confirmation'),
    ('shopify','disable_coupon'), ('shopify','update_customer'),
    ('shopify','update_metafield'), ('hubspot','create_deal'),
    ('aws_rds','insert_row'), ('mongodb','insert_document'),
    ('postgresql','insert_row')
  );

-- ── Report AFTER state + tenant-override preservation ───────────────────────
DO $$
DECLARE n_high_never int; n_always int; n_overrides int; n_tenants int;
BEGIN
  SELECT count(*) INTO n_high_never
  FROM catalog_tools
  WHERE risk_level = 'HIGH' AND coalesce(hitl_policy->>'mode','never') = 'never';

  SELECT count(*) INTO n_always
  FROM catalog_tools WHERE hitl_policy->>'mode' = 'always';

  SELECT count(*), count(DISTINCT tenant_id) INTO n_overrides, n_tenants
  FROM tenant_tools
  WHERE config_overrides ? 'hitlPolicy';

  RAISE NOTICE '[tool-hitl] AFTER: % HIGH-risk tools default to autonomous (target 0); % tools require approval',
    n_high_never, n_always;
  RAISE NOTICE '[tool-hitl] tenant overrides untouched: % rows across % tenants',
    n_overrides, n_tenants;

  IF n_high_never > 0 THEN
    RAISE WARNING '[tool-hitl] % HIGH-risk tools still default to autonomous - review them', n_high_never;
  END IF;
END $$;
