# RFC 0006. Agent read scope gap

- Status: Proposed
- Date: 2026-07-21
- Scope: Design only. This RFC does not change the MCP tool surface, OAuth scope advertisement, agent catalog, or production code.

## 1. Problem

The public launch agents expose a metadata contract that is not fully backed by
the public MCP resource server.

The internal catalog declares these read scopes:

- `compliance`: `policy:read`, `audit:read`, `ledger:read`
- `dispute`: `ledger:read`, `wiki:read`, `raw:read`
- `fraud_anomaly`: `ledger:read`, `wiki:read`, `raw:read`
- `vendor_risk`: `ledger:read`, `wiki:read`, `raw:read`

The live protected-resource metadata advertises only `ledger:read`,
`wiki:read`, `raw:write`, `payment_intent:propose`, and
`execution:propose`. No MCP tool consumes `raw:read`, `policy:read`, or
`audit:read`. A third-party operator therefore cannot consent to those scopes,
and the public skills cannot gather that evidence through MCP even though the
skills declare it.

The public `brain-skills` repository now guards this with
`scripts/check-scopes.mjs`. The guard has an explicit allowlist for these
residual gaps. The goal of this RFC is to choose how to burn that allowlist
down without weakening the propose-only invariant.

## 2. Source map

This design is grounded in the current code.

- Agent metadata:
  - `services/internal-agents/src/compliance/definition.ts`
  - `services/internal-agents/src/dispute/definition.ts`
  - `services/internal-agents/src/fraud_anomaly/definition.ts`
  - `services/internal-agents/src/vendor_risk/definition.ts`
  - `services/internal-agents/src/registry.ts`
- MCP tool registry and enforcement:
  - `services/mcp/src/tools/registry.ts`
  - `services/mcp/src/tools/raw.ts`
  - `services/mcp/src/tools/proposals.ts`
  - `services/mcp/src/tools/evidence.ts`
  - `services/mcp/src/resources.ts`
  - `services/mcp/src/server.ts`
  - `services/mcp/src/tools/registry.no-execute.test.ts`
- OAuth protected-resource metadata and scope vocabulary:
  - `services/api/src/well-known/oauth-protected-resource.ts`
  - `services/api/src/main.ts`
  - `shared/src/auth/scopes.ts`
  - `services/mcp/src/auth.ts`
- Tenant-scoped storage and RLS:
  - `shared/src/db/tenant-scoped.ts`
  - `infra/db-roles.sql`
  - `services/raw/migrations/0001_raw_artifacts.sql`
  - `services/raw/migrations/0002_raw_parsed.sql`
  - `services/raw/migrations/0005_raw_sources.sql`
  - `services/policy/migrations/0001_policies.sql`
  - `services/policy/migrations/0002_policy_decisions.sql`
  - `services/audit/migrations/0001_audit_events.sql`
- Existing internal readers:
  - `services/raw/src/repository/artifacts.ts`
  - `services/raw/src/repository/parsed.ts`
  - `services/raw/src/routes/artifact.ts`
  - `services/policy/src/repository.ts`
  - `services/policy/src/routes.ts`
  - `services/audit/src/repository.ts`
  - `services/audit/src/routes.ts`
  - `services/api/src/agents/compliance-scanner.ts`
  - `services/api/src/agents/dispute-scanner.ts`
  - `services/api/src/agents/fraud-anomaly-scanner.ts`
  - `services/api/src/agents/vendor-risk-scanner.ts`
- Public spec publication:
  - `tools/skills-spec/generate.ts`
  - `tools/skills-spec/README.md`
  - `.github/workflows/skills-spec.yml`

`tools/skills-spec/generate.ts` emits the public-safe launch-agent catalog that
feeds `brain-skills/spec/brain-agents.json`. The workflow publishes that file to
`braindotfi/brain-skills`. The public MCP tool snapshot in
`brain-skills/spec/brain-mcp-tools.json` is generated from
`services/mcp/src/tools/*.ts` by the public repo drift tooling, not by the
current brain-core skills-spec generator.

## 3. Current constraints

The MCP server returns the full tool list from `ALL_TOOLS` and enforces each
tool's `requiredScopes` at `tools/call`. Resources use the same pattern through
`resources/read`.

Agent OAuth scope advertisement is not derived from the tool registry. The
protected-resource metadata in `services/api/src/main.ts` advertises
`AGENT_PERMITTED_SCOPES` from `shared/src/auth/scopes.ts`. Adding a new public
read scope therefore requires both a tool with `requiredScopes` and an update to
`AGENT_PERMITTED_SCOPES`.

The request path is tenant-scoped through `withTenantScope`, which runs a
transaction and sets `app.tenant_id`. The relevant tables have RLS predicates of
the form:

```sql
tenant_id = current_setting('app.tenant_id', true)
```

The current `brain_app` role has broad request-path DML. The least-privilege
implementation should introduce a dedicated MCP read role rather than relying
on broad request-path grants for these new tools.

## 4. `raw:read`

### Dependent evidence

`dispute`, `fraud_anomaly`, and `vendor_risk` declare `raw:read`.

The dependent evidence is not arbitrary data lake browsing. The public agents
need source-backed evidence behind a specific ledger or trigger context:

- `dispute` needs chargeback source material, disputed transaction support, and
  parsed provider or upload facts that explain why a dispute packet is valid.
- `fraud_anomaly` needs source evidence behind a transaction, duplicate, or
  merchant-risk signal, including parser confidence and source provenance.
- `vendor_risk` needs vendor onboarding artifacts, payment-destination source
  facts, and historical counterparty evidence tied to a specific counterparty
  or payment instruction.

`wiki.question` can answer a narrative version of some of this because Wiki is
projected from Ledger. It loses raw artifact identity, source reference,
content hash, parser version, parser confidence, and whether the current ledger
fact came from an uploaded document, a provider pull, an agent contribution, or
another source. For dispute packets and vendor-risk review, that loss removes
the provenance needed to cite the evidence. For fraud review, it can collapse a
source-level anomaly into a ledger summary without the confidence and duplicate
artifact context.

### Recommended disposition

Expose a narrow read-only MCP tool.

Tool: `raw.artifact.get`

Scope: `raw:read`

Input schema:

```json
{
  "type": "object",
  "required": ["raw_id"],
  "properties": {
    "raw_id": { "type": "string", "description": "Brain raw artifact id." },
    "include_parsed": {
      "type": "boolean",
      "default": true,
      "description": "Include parser outputs for the artifact."
    }
  }
}
```

Returned fields:

- `raw_id`
- `sha256`
- `source_type`
- `source_ref`
- `mime_type`
- `bytes`
- `ingested_at`
- `tombstoned_at`
- `ingested_by`
- ingestion-envelope fields present on `raw_artifacts`
- `parsed`: zero or more parser rows with `id`, `parser`, `parser_version`,
  `extracted`, `confidence`, and `extracted_at`

The first implementation should not return `blob_uri` or a signed blob URL. The
existing HTTP `GET /raw/:raw_id` route can return a signed URL for principals
that hold `raw:read`, but the public MCP skill need is provenance and parsed
evidence, not direct blob download. Keeping blob access out of MCP reduces the
third-party token blast radius.

Least-privilege DB role:

```sql
CREATE ROLE brain_mcp_reader LOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO brain_mcp_reader;
GRANT SELECT (
  id, tenant_id, sha256, source_type, source_ref, mime_type, bytes,
  ingested_at, tombstoned_at, ingested_by, source_schema, object_type,
  external_id, operation, effective_at, observed_at, original_source,
  intermediaries, source_id, source_version, idempotency_key
) ON raw_artifacts TO brain_mcp_reader;
GRANT SELECT (
  id, raw_artifact_id, tenant_id, parser, parser_version, extracted,
  confidence, extracted_at
) ON raw_parsed TO brain_mcp_reader;
```

RLS predicate:

```sql
tenant_id = current_setting('app.tenant_id', true)
```

The tool must run under `withTenantScope` or an equivalent wrapper that sets
`app.tenant_id` from the verified JWT tenant. It must not list artifacts, return
blob paths, mint signed URLs, write Raw rows, execute actions, sign policies, or
bypass RLS.

### Downstream changes if adopted

- Keep `raw:read` in the internal-agent definitions for `dispute`,
  `fraud_anomaly`, and `vendor_risk`.
- Add `raw.artifact.get` in `services/mcp/src/tools/raw.ts`.
- Register the tool through `services/mcp/src/tools/registry.ts`.
- Extend `services/mcp/src/tools/registry.no-execute.test.ts` so the snapshot
  change is explicit and the no-execute invariant remains hard.
- Add `raw:read` to `AGENT_PERMITTED_SCOPES`.
- Include `raw:read` in protected-resource metadata through the existing
  `AGENT_PERMITTED_SCOPES` wiring.
- Update the public MCP tool snapshot consumed by
  `brain-skills/spec/brain-mcp-tools.json`.
- Regenerate `brain-skills/spec/brain-agents.json` only if catalog content
  changes.
- Update `brain-skills/_shared/brain-mcp.md` and the 11 byte-identical
  reference copies.
- Remove the `raw:read` allowlist entry from
  `brain-skills/scripts/check-scopes.mjs`.

### Security analysis

A third-party agent token with `raw:read` could read tenant-scoped raw artifact
metadata and parsed evidence for a raw id it already knows. That can include
source references, provider identifiers, uploaded document metadata, and parser
output. The recommended tool intentionally avoids artifact listing and signed
blob URLs, so the caller cannot browse the raw store or download arbitrary
source bytes through MCP.

The blast radius is one tenant, one artifact id per call, enforced by JWT tenant
binding, on-chain scope hash verification, `withTenantScope`, RLS, and a
read-only DB role. This is acceptable because the dependent public skills need
source provenance to make evidence claims, and the tool does not create,
approve, execute, sign, or mutate anything.

## 5. `policy:read`

### Dependent evidence

`compliance` declares `policy:read` and requires `policy_decision` evidence.
The scanner already builds findings from `policy_decisions`, including
`policy_decision_id`, `policy_outcome`, `matched_rule_id`, required approver
counts, and related subjects.

`wiki.question` can summarize policy posture if the relevant facts have been
projected into Wiki, but it cannot provide an exact policy-decision proof. The
fidelity loss is material: the skill loses the decision id, policy version,
matched rule id, required approver set, ledger snapshot hash, decision trace,
and the exact subject that was evaluated.

### Recommended disposition

Expose a narrow read-only MCP tool.

Tool: `policy.decision.get`

Scope: `policy:read`

Input schema:

```json
{
  "type": "object",
  "required": ["policy_decision_id"],
  "properties": {
    "policy_decision_id": {
      "type": "string",
      "description": "Brain policy decision id."
    }
  }
}
```

Returned fields:

- `policy_decision_id`
- `policy_id`
- `policy_version`
- `subject_type`
- `subject_id`
- `outcome`
- `matched_rule_id`
- `required_approvers`
- `ledger_snapshot_hash`
- `trace`
- `decided_at`
- `policy_content_hash`
- `policy_state`

The first implementation should not expose full policy content through MCP.
Policy content can reveal internal spend controls, signer thresholds, and
business control logic. The decision trace, rule id, version, and content hash
preserve the evidence needed by the compliance skill without making the full
policy document a public MCP read surface.

Least-privilege DB role:

```sql
CREATE ROLE brain_mcp_reader LOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO brain_mcp_reader;
GRANT SELECT (
  id, tenant_id, policy_id, policy_version, subject_type, subject_id,
  outcome, matched_rule_id, required_approvers, ledger_snapshot_hash,
  trace, decided_at
) ON policy_decisions TO brain_mcp_reader;
GRANT SELECT (
  id, tenant_id, version, content_hash, state, activated_at, deactivated_at
) ON policies TO brain_mcp_reader;
```

RLS predicate:

```sql
tenant_id = current_setting('app.tenant_id', true)
```

The tool must read only by id, return not-found for absent or cross-tenant ids,
and must not compose, sign, activate, deactivate, evaluate a new action, or
bypass policy gates.

### Downstream changes if adopted

- Keep `policy:read` in the `compliance` internal-agent definition.
- Add `policy.decision.get` in a new or existing MCP policy tool module.
- Register the tool through `services/mcp/src/tools/registry.ts`.
- Extend `services/mcp/src/tools/registry.no-execute.test.ts` so the snapshot
  change is explicit and the no-execute invariant remains hard.
- Add `policy:read` to `AGENT_PERMITTED_SCOPES`.
- Include `policy:read` in protected-resource metadata through the existing
  `AGENT_PERMITTED_SCOPES` wiring.
- Update the public MCP tool snapshot consumed by
  `brain-skills/spec/brain-mcp-tools.json`.
- Regenerate `brain-skills/spec/brain-agents.json` only if catalog content
  changes.
- Update `brain-skills/_shared/brain-mcp.md` and the 11 byte-identical
  reference copies.
- Remove the `policy:read` allowlist entry from
  `brain-skills/scripts/check-scopes.mjs`.

### Security analysis

`policy:read` is higher-sensitivity than `raw:read`. A third-party agent token
could learn policy outcomes, required approver classes, matched rule ids,
decision traces, and hashes that correspond to internal control logic. Even
without full policy content, this can reveal operational thresholds and where a
payment or agent action failed.

The blast radius is acceptable only if the tool is narrow, single-decision,
tenant-scoped, read-only, and excludes full policy content. It should be granted
only to public agents whose catalog declares `policy:read`, and the operator
must see `policy:read` in OAuth consent. The tool preserves the propose-only
invariant because it cannot mutate policies, sign policies, approve proposals,
or execute payment intents.

## 6. `audit:read`

### Dependent evidence

`compliance` declares `audit:read` and requires `audit_event` evidence. The
scanner builds compliance findings from `audit_events` and passes
`audit_event_id` into the agent context. The MCP resources layer also has a
`brain://proofs/{action_id}` resource gated by `audit:read`, but the scope is
not externally grantable through the current protected-resource metadata.

`wiki.question` can summarize historical activity if the relevant audit facts
were projected into Wiki, but it cannot prove audit completeness or event
identity. The fidelity loss is material: the skill loses the exact event id,
actor, action, inputs, outputs, policy version, event hash, previous hash,
created timestamp, and inclusion context. For audit-gap findings, a narrative
summary is specifically the wrong evidence shape because the question is
whether the audit trail itself contains or lacks the expected event.

### Recommended disposition

Expose a narrow read-only MCP tool.

Tool: `audit.event.get`

Scope: `audit:read`

Input schema:

```json
{
  "type": "object",
  "required": ["audit_event_id"],
  "properties": {
    "audit_event_id": {
      "type": "string",
      "description": "Brain audit event id."
    }
  }
}
```

Returned fields:

- `audit_event_id`
- `layer`
- `actor`
- `action`
- `inputs`
- `outputs`
- `policy_version`
- `event_hash`
- `prev_event_hash`
- `created_at`

The first implementation should not expose an MCP list or export tool. The
existing HTTP audit routes have broader read surfaces for API keys and users,
including event query, entity query, export, and anchor reads. Public MCP should
start with a single event get because the scanner context already carries an
event id.

Least-privilege DB role:

```sql
CREATE ROLE brain_mcp_reader LOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO brain_mcp_reader;
GRANT SELECT (
  id, tenant_id, layer, actor, action, inputs, outputs, policy_version,
  event_hash, prev_event_hash, created_at
) ON audit_events TO brain_mcp_reader;
```

RLS predicate:

```sql
tenant_id = current_setting('app.tenant_id', true)
```

The tool must read only by id, return not-found for absent or cross-tenant ids,
and must not list events, export audit logs, publish anchors, verify privileged
state, write audit events, or bypass RLS.

### Downstream changes if adopted

- Keep `audit:read` in the `compliance` internal-agent definition.
- Add `audit.event.get` in a new or existing MCP audit tool module.
- Register the tool through `services/mcp/src/tools/registry.ts`.
- Extend `services/mcp/src/tools/registry.no-execute.test.ts` so the snapshot
  change is explicit and the no-execute invariant remains hard.
- Add `audit:read` to `AGENT_PERMITTED_SCOPES`.
- Include `audit:read` in protected-resource metadata through the existing
  `AGENT_PERMITTED_SCOPES` wiring.
- Decide whether `brain://proofs/{action_id}` becomes externally usable when
  `audit:read` is advertised, or whether proof reads need a narrower scope or
  additional review before advertisement.
- Update the public MCP tool snapshot consumed by
  `brain-skills/spec/brain-mcp-tools.json`.
- Regenerate `brain-skills/spec/brain-agents.json` only if catalog content
  changes.
- Update `brain-skills/_shared/brain-mcp.md` and the 11 byte-identical
  reference copies.
- Remove the `audit:read` allowlist entry from
  `brain-skills/scripts/check-scopes.mjs`.

### Security analysis

`audit:read` is higher-sensitivity than `raw:read` and at least as sensitive as
the proposed `policy:read` surface. A third-party agent token could read who
did what, when it happened, which policy version applied, and the serialized
inputs and outputs attached to an event. That can reveal internal operations,
approval behavior, failure modes, identifiers, and sensitive business context.

The blast radius is acceptable only if the first public MCP surface is a
single-event getter, not an audit search or export API. The agent must already
know the event id from trigger context or another scoped source. Tenant binding,
on-chain scope hash verification, `withTenantScope`, RLS, and a read-only DB
role keep the read bounded. The tool preserves the propose-only invariant
because it is read-only and does not approve, execute, sign, or write.

## 7. Implementation sequencing after approval

If this RFC is approved, implement in separate PRs:

1. Add the least-privilege `brain_mcp_reader` role grants and any runtime wiring
   needed for MCP read-only tools to use that role under `withTenantScope`.
2. Add `raw.artifact.get` with tests, registry snapshot update, and OAuth
   advertisement for `raw:read`.
3. Add `policy.decision.get` with tests, registry snapshot update, and OAuth
   advertisement for `policy:read`.
4. Add `audit.event.get` with tests, registry snapshot update, and OAuth
   advertisement for `audit:read`, including an explicit decision on the
   existing proof resource exposure.
5. Update public spec generation or snapshot publication so
   `brain-skills/spec/brain-mcp-tools.json` is produced from
   `services/mcp/src/tools/*.ts` as a repeatable output.
6. Regenerate public `brain-skills` specs, update shared MCP contract docs and
   11 reference copies, and remove the burned-down allowlist entries from
   `scripts/check-scopes.mjs`.

## 8. Recommendation table

| Scope         | Chosen option                                                                   | Risk                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `raw:read`    | Expose `raw.artifact.get`, read-only, tenant-scoped, no blob URL and no list.   | Medium. Source metadata and parsed evidence are sensitive, but the surface is single-artifact and excludes raw blob download.             |
| `policy:read` | Expose `policy.decision.get`, read-only, tenant-scoped, no full policy content. | Medium high. Decision traces and rule ids reveal control behavior, but the tool is single-decision and avoids policy mutation or signing. |
| `audit:read`  | Expose `audit.event.get`, read-only, tenant-scoped, no list and no export.      | High. Audit events reveal operational history, so the first surface must be single-event only and require explicit operator consent.      |
