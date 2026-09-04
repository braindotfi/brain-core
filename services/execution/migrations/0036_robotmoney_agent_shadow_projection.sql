-- Project existing Brain agents into the observe-only RobotMoney agent model.
-- A projection is created only when the tenant has exactly one active entity.

BEGIN;

WITH single_entity AS (
  SELECT tenant_id, min(id) AS entity_id
    FROM robotmoney_entities
   WHERE state = 'active'
   GROUP BY tenant_id
  HAVING count(*) = 1
)
INSERT INTO robotmoney_agent_instances (
  id,
  tenant_id,
  entity_id,
  runtime_agent_id,
  display_name,
  lifecycle_state,
  system_bootstrap,
  demo_instance,
  created_by
)
SELECT
  'cmai_' || upper(substr(md5(agent.id), 1, 26)),
  agent.tenant_id,
  entity.entity_id,
  agent.id,
  agent.display_name,
  CASE
    WHEN agent.state = 'active' THEN 'active'
    WHEN agent.state = 'revoked' THEN 'deleted'
    ELSE 'draft'
  END,
  agent.kind = 'internal',
  COALESCE(tenant.data_profile LIKE 'synthetic_%', FALSE),
  'commercial_agent_shadow_projection_v1'
FROM agents AS agent
JOIN single_entity AS entity ON entity.tenant_id = agent.tenant_id
JOIN tenants AS tenant ON tenant.id = agent.tenant_id
ON CONFLICT (tenant_id, runtime_agent_id) DO NOTHING;

COMMIT;
