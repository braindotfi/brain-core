-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Execution table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. See ledger/0020_force_rls.sql for
-- the full rationale.

BEGIN;

ALTER TABLE agents                    FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_action_sagas        FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_evidence_refs       FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_finding_overrides   FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_findings            FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_idempotency_keys    FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_reasoning_traces    FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_routing_decisions   FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs                FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps           FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_saga_steps          FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals                 FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_events             FORCE ROW LEVEL SECURITY;
ALTER TABLE execution_outbox          FORCE ROW LEVEL SECURITY;
ALTER TABLE executions                FORCE ROW LEVEL SECURITY;
ALTER TABLE proposals                 FORCE ROW LEVEL SECURITY;
ALTER TABLE users                     FORCE ROW LEVEL SECURITY;

COMMIT;
