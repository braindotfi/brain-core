-- Backfill the post-0023 tenant bootstrap gap.
--
-- Migration 0023 promoted identities that existed at migration time. Tenants
-- created after that one-time backfill but before provisioning wrote members
-- can have zero rows in `members`, which makes the admin-only members API
-- unreachable. This migration is idempotent and creates exactly one active
-- admin for every tenant that still has zero members.
--
-- Selection rule:
--   1. Prefer the earliest user for that tenant, preserving session identity.
--   2. Otherwise prefer the earliest agent, preserving demo provision tokens.
--   3. Otherwise create a deterministic placeholder member id and email.
--
-- The placeholder can be patched by an admin after a real identity is linked.

BEGIN;

WITH zero_member_tenants AS (
  SELECT t.id AS tenant_id
    FROM tenants t
   WHERE NOT EXISTS (
     SELECT 1 FROM members m WHERE m.tenant_id = t.id
   )
),
first_user AS (
  SELECT DISTINCT ON (u.tenant_id)
         u.tenant_id,
         u.id,
         lower(u.email) AS email,
         u.email AS display_name,
         u.created_at
    FROM users u
    JOIN zero_member_tenants z ON z.tenant_id = u.tenant_id
   WHERE u.email IS NOT NULL
   ORDER BY u.tenant_id, u.created_at ASC, u.id ASC
),
first_agent AS (
  SELECT DISTINCT ON (a.tenant_id)
         a.tenant_id,
         a.id,
         lower('bootstrap+' || a.tenant_id || '@brain.invalid') AS email,
         a.display_name,
         a.created_at
    FROM agents a
    JOIN zero_member_tenants z ON z.tenant_id = a.tenant_id
   ORDER BY a.tenant_id, a.created_at ASC, a.id ASC
),
bootstrap_source AS (
  SELECT
    z.tenant_id,
    COALESCE(
      u.id,
      a.id,
      'user_bootstrap_' || substr(md5(z.tenant_id), 1, 16)
    ) AS member_id,
    COALESCE(
      u.email,
      a.email,
      lower('bootstrap+' || z.tenant_id || '@brain.invalid')
    ) AS email,
    COALESCE(
      NULLIF(u.display_name, ''),
      NULLIF(a.display_name, ''),
      'Bootstrap Admin'
    ) AS display_name
  FROM zero_member_tenants z
  LEFT JOIN first_user u ON u.tenant_id = z.tenant_id
  LEFT JOIN first_agent a ON a.tenant_id = z.tenant_id
)
INSERT INTO members (
  tenant_id,
  id,
  email,
  display_name,
  role,
  active,
  approval_domains,
  per_item_limit_cents,
  requires_second_approver_above_cents,
  created_at,
  updated_at
)
SELECT
  tenant_id,
  member_id,
  email,
  display_name,
  'admin',
  true,
  ARRAY['ap', 'ar', 'treasury', 'payroll', 'reconciliation']::TEXT[],
  9223372036854775807,
  NULL::BIGINT,
  now(),
  now()
FROM bootstrap_source
ON CONFLICT (tenant_id, id) DO NOTHING;

COMMIT;
