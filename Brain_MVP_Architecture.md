# Brain MVP Architecture

Financial Intelligence Protocol, Minimum Viable Build

Brain Finance Inc. | Delaware | brain.fi v0.2, MVP Blueprint

## Purpose of this document

This is the MVP architecture: the smallest thing we can build that (1) proves the five-layer protocol works end to end, (2) lands design-partner revenue, and (3) gives a Series A lead enough to underwrite the scale-up round.

Everything that doesn't clear all three bars has been cut. Nothing in here is here because it sounds good, it's here because removing it breaks one of those three bars.

## 1. The protocol in one page

Brain turns financial activity into memory, memory into intelligence, and intelligence into execution. It does not hold funds. It does not move money directly. It sits between an account holder and their financial world as the structured intelligence layer.

Five layers, each with a public API:

┌─────────────────────────────────────────────────────────┐
│ CONSUMERS: Business UI · Consumer app · API partners │
└───────────────┬─────────────────────────────────────────┘
 │
 ┌───────────▼───────────┐
 │ 5. AUDIT │ Merkle log, on-chain anchor
 └───────────▲───────────┘
 ┌───────────┴───────────┐
 │ 4. EXECUTION │ Agents, MCP server
 └───────────▲───────────┘
 ┌───────────┴───────────┐
 │ 3. POLICY │ Rules VM, versioning, signing
 └───────────▲───────────┘
 ┌───────────┴───────────┐
 │ 2. WIKI │ Structured memory (Postgres)
 └───────────▲───────────┘
 ┌───────────┴───────────┐
 │ 1. RAW │ Immutable ingestion
 └───────────────────────┘

Every action produces new Raw evidence, which updates the Wiki, which sharpens reasoning, which drives the next action. The loop is the moat.

The Wiki is a compiled, continuously-updated artifact derived from Raw, the same pattern as Karpathy's LLM Wiki, but online and multi-tenant. Source immutability means the Wiki can always be re-derived from Raw, which is the property that makes the protocol auditable.

## 2. Tech stack

One stack. Boring on purpose. Every choice here is a default that gets the team to shipping fast and lets the interesting engineering happen in the domain layer, not the infrastructure.

What's deliberately not in the stack: graph databases, Kafka, Kubernetes, a separate search service, a separate vector DB, a workflow engine (Temporal/Airflow), a feature flag service, Terraform Cloud. We will need some of these later. Not now.

## 3. The five layers

Each layer has a minimal public API and a minimal data model. Nothing else.

### Layer 1: Raw (Ingestion)

What it does. Accept financial evidence from any source, store it immutably, fingerprint it, make it retrievable by hash.

Data model (Postgres).

-- The manifest. One row per ingested artifact.
raw_artifacts (
 id UUID PK,
 tenant_id UUID NOT NULL, -- row-level security pivot
 sha256 BYTEA NOT NULL, -- content address
 source_type TEXT NOT NULL, -- plaid | erp_netsuite | email | upload | chain_evm | ...
 source_ref JSONB, -- source-specific identifiers
 blob_uri TEXT NOT NULL, -- where the blob lives
 mime_type TEXT,
 bytes BIGINT,
 ingested_at TIMESTAMPTZ DEFAULT now(),
 tombstoned_at TIMESTAMPTZ, -- deletion is a tombstone, never a mutation
 UNIQUE (tenant_id, sha256)
)

-- Parser output. One row per (artifact, parser_version).
raw_parsed (
 id UUID PK,
 raw_artifact_id UUID REFERENCES raw_artifacts(id),
 parser TEXT NOT NULL, -- plaid_tx_v1 | pdf_ocr_v2 | ...
 parser_version TEXT NOT NULL,
 extracted JSONB NOT NULL, -- normalized output
 confidence REAL, -- 0.0 to 1.0 where applicable
 extracted_at TIMESTAMPTZ DEFAULT now()
)

Public API.

POST /v1/raw/ingest upload or URL; returns {raw_id, sha256}
POST /v1/raw/webhooks/{provider} Plaid, Stripe, generic HMAC
GET /v1/raw/{raw_id} short-lived signed URL
GET /v1/raw/{raw_id}/parsed parsed output for all parser versions
DELETE /v1/raw/{raw_id} writes tombstone, does not mutate

MVP scope. Five source adapters plus one agent-contribution path. The adapters are Plaid (banking), a generic CSV/PDF upload endpoint, NetSuite (most-used ERP in mid-market), Gmail OAuth (invoice capture), and an EVM chain adapter (Alchemy). That covers the finance team's top sources. In addition, a sixth source_type value, agent_contributed, accepts artifacts pushed by authorized external AI agents (transcripts, documents, structured observations). Agent contributions are content-addressed like any other Raw artifact, attributed to the agent's on-chain registration record in BrainMCPAgentRegistry, and carry the agent's signature as part of their provenance chain. Other source-specific adapters (Slack, Teams, non-EVM chains, custom tenant sources via BYOS) are post-MVP.

Agent contribution governance. An external agent can only contribute to Raw if its tenant's registration record in BrainMCPAgentRegistry explicitly grants the raw:write scope. The tenant authorizes this scope at agent registration time with an EIP-712 signature. Revocation is immediate and on-chain. Agent-contributed artifacts are filtered from standard extraction pipelines until the tenant confirms the agent is trusted (default trust level: quarantine on first N contributions, auto-approve after). This is what keeps agent contributions from polluting the Wiki.

What's NOT in MVP. Real-time streaming. Slack/Teams adapters (though agents can contribute transcripts via the agent path). Non-EVM chains. Automatic redaction tooling (manual redaction endpoint only). Multi-region replication of the raw blob store (single region, backup only). A generic Bring-Your-Own-Source (BYOS) adapter framework letting developers write their own tenant-facing ingestion connectors. That capability is explicitly deferred to post-MVP and tracked separately.

### Layer 2: Wiki (Memory)

What it does. Maintain a structured, continuously updated model of the tenant's financial life. Answer questions. Expose entities and their relationships.

Data model (Postgres).

-- Entities. Everything is an entity: accounts, counterparties, transactions, obligations, policies, agents.
wiki_entities (
 id UUID PK,
 tenant_id UUID NOT NULL,
 kind TEXT NOT NULL, -- account | counterparty | transaction | obligation | agreement | ...
 attributes JSONB NOT NULL, -- type-specific fields, validated against kind's JSON schema
 embedding vector(1536), -- pgvector; nullable for entities that don't need semantic search
 valid_from TIMESTAMPTZ NOT NULL,
 valid_to TIMESTAMPTZ, -- NULL = currently valid
 provenance TEXT NOT NULL, -- extracted | inferred | ambiguous | human_confirmed | agent_contributed
 confidence REAL NOT NULL, -- 0.0 to 1.0
 source_evidence UUID[] NOT NULL, -- raw_parsed ids
 created_at TIMESTAMPTZ DEFAULT now(),
 INDEX (tenant_id, kind),
 INDEX USING ivfflat (embedding vector_cosine_ops)
)

-- Relations. An edge between two entities.
wiki_relations (
 id UUID PK,
 tenant_id UUID NOT NULL,
 src UUID REFERENCES wiki_entities(id),
 dst UUID REFERENCES wiki_entities(id),
 kind TEXT NOT NULL, -- transacted_with | owns | owes | governed_by | ...
 attributes JSONB,
 valid_from TIMESTAMPTZ NOT NULL,
 valid_to TIMESTAMPTZ,
 provenance TEXT NOT NULL,
 confidence REAL NOT NULL,
 source_evidence UUID[] NOT NULL,
 INDEX (tenant_id, src), INDEX (tenant_id, dst), INDEX (tenant_id, kind)
)

Four things to notice. (1) Every row carries provenance + confidence + source_evidence. This is non-negotiable and it's what makes the Wiki auditable. (2) Bitemporal: valid_from/valid_to lets us answer "what did we know on March 14" without a graph database. (3) attributes is JSONB, validated against a per-kind JSON Schema kept in code and versioned. (4) Recursive CTEs handle the multi-hop queries we actually need in Year 1. When that stops being true, we introduce a graph read-replica, not before.

Public API.

GET /v1/wiki/entity/{id} entity + 1-hop neighbors
GET /v1/wiki/entity/{id}/evidence source evidence chain
GET /v1/wiki/entity/{id}/history all temporal versions
GET /v1/wiki/search filters: kind, attributes, time range
POST /v1/wiki/question NL question → structured answer + evidence path
POST /v1/wiki/annotate human correction on an entity/relation
GET /v1/wiki/schema current JSON schemas per kind

The /question endpoint is where Claude sits in the hot path. It takes a natural-language question, translates it to a small number of SQL queries against the Wiki, executes them, and composes an answer with the evidence path attached. This is Brain's "feel", ask anything about your money and get a grounded answer with receipts.

MVP scope. Six entity kinds: account, counterparty, transaction, obligation, policy, agent. Four relation kinds: transacted_with, owes, owed_by, governed_by. Five provenance values: extracted, inferred, ambiguous, human_confirmed, agent_contributed. Everything else is post-MVP.

Agent contributions to the Wiki. When an external agent pushes a Raw artifact (see Layer 1) and the extraction pipeline derives entities from it, those derived entities carry provenance=agent_contributed and reference the agent's BrainMCPAgentRegistry record in their source_evidence field. Agent-contributed entities start at a confidence ceiling of 0.5 regardless of how certain the extractor is, and can only be promoted above 0.5 by one of three things: (1) confirmation by a subsequent extracted or human_confirmed observation, (2) explicit tenant approval via /wiki/annotate, or (3) corroboration by a second independent agent's contribution. This is the governance boundary that keeps a malicious or poorly-calibrated agent from corrupting the Wiki.

What's NOT in MVP. A graph database. Contradiction detection beyond exact-match. Automatic entity resolution across tenants. A natural-language write path (annotations are structured, not conversational). Cross-tenant agent memory sharing (an agent's contributions to tenant A's Wiki are never visible to tenant B under any circumstances).

### Layer 3: Policy (Governance)

What it does. Encode what a tenant allows as a versioned, signable artifact. Evaluate proposed actions against the active policy. Return allow / confirm / reject with a trace.

Data model.

policies (
 id UUID PK,
 tenant_id UUID NOT NULL,
 version INT NOT NULL,
 content JSONB NOT NULL, -- the compiled rule tree
 content_hash BYTEA NOT NULL, -- SHA-256 of canonical content
 signers JSONB, -- [{address, signature}] for enterprise tier
 activated_at TIMESTAMPTZ NOT NULL,
 deactivated_at TIMESTAMPTZ,
 UNIQUE (tenant_id, version)
)

Policy DSL, MVP primitive set.

rules:
 - id: <string>
 applies_to: [outbound_payment | inbound_payment | ledger_write | onchain_tx | any]
 when:
 counterparty.in: <list_ref> # vendors.trusted, etc.
 counterparty.not_in: <list_ref>
 amount.lte: {currency, value}
 amount.gt: {currency, value}
 agent.role: <role>
 time_window: <cron_expr>
 require: [single_signer | <role>_approval | <role>_and_<role>]
 execute: auto | confirm | reject

Six primitives cover the approval matrices we've seen in design-partner interviews. Jurisdictional rules, delegation chains, and more exotic constructs are post-MVP.

Public API.

GET /v1/policy/{tenant_id} active policy
GET /v1/policy/{tenant_id}/versions version history
POST /v1/policy/{tenant_id}/compose new policy → returns signing payload
POST /v1/policy/{tenant_id}/sign submit signatures
POST /v1/policy/{tenant_id}/evaluate {action} → {decision, trace, required_approvers}
POST /v1/policy/{tenant_id}/simulate replay action against historical version

Signing. EIP-712 typed-data signatures. Enterprise tier gets on-chain policy registration (see smart contracts below). SMB tier gets off-chain signed policies stored in Postgres. Same primitive, different durability surface.

MVP scope. Business policies only. Consumer "autonomy level" (Notify / Confirm / Execute) is a single built-in rule template, not a DSL composition.

What's NOT in MVP. Multi-jurisdictional rules. Complex delegation chains. Policy diffing/merging. Policy linting.

### Layer 4: Execution (Action)

What it does. Run specialized agents that read the Wiki, propose actions, pass them through Policy, execute approved actions, and log everything.

Agents in MVP. Three. No more.

reconciliation-agent: matches bank-feed transactions to ERP entries, flags mismatches. Zero write authority. Runs continuously. High ROI with no policy risk because it doesn't move money, the right first agent to demo.

payment-agent: proposes outbound payments from AP queue, evaluates against policy, and executes through one of two rails depending on the action: (a) fiat via the tenant's bank API when approved; (b) on-chain via the tenant's BrainSmartAccount (ERC-4337 smart account, see contracts) for stablecoin payments, crypto vendor payments, and on-chain counterparty settlements. Every on-chain action is pre-checked against the policy fingerprint registered in BrainPolicyRegistry and logged with a cryptographic receipt anchored via BrainAuditAnchor. Write authority is gated entirely by policy, the agent cannot move funds outside the session key's scope under any circumstance.

anomaly-agent: watches the transaction stream, flags unusual activity (new counterparty over threshold, velocity spikes, known-bad address hits via Chainalysis). Zero write authority. Notifies only.

These three cover the demo, generate immediate ROI, and exercise the full five-layer stack end-to-end. Treasury, FX, payroll, tax, on-chain yield agents are post-MVP.

Data model.

proposals (
 id UUID PK,
 tenant_id UUID,
 proposing_agent TEXT NOT NULL,
 action JSONB NOT NULL,
 policy_version INT NOT NULL,
 policy_decision TEXT NOT NULL, -- allow | confirm | reject
 policy_trace JSONB NOT NULL,
 required_approvers TEXT[],
 status TEXT NOT NULL, -- pending | approved | rejected | executed | failed
 created_at TIMESTAMPTZ DEFAULT now()
)

executions (
 id UUID PK,
 proposal_id UUID REFERENCES proposals(id),
 rail TEXT NOT NULL, -- bank_ach | erp_writeback | onchain_base | notification
 rail_receipt JSONB, -- provider-specific receipt
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 status TEXT NOT NULL
)

Public API.

POST /v1/execution/propose agent proposes; returns policy decision
POST /v1/execution/execute execute approved proposal
GET /v1/execution/{execution_id} status + trace
POST /v1/execution/approve human approval for `confirm` proposals
POST /v1/execution/escalate agent escalation to human
GET /v1/execution/agents configured agents for tenant
POST /v1/execution/agents/register register external agent; returns on-chain attestation
GET /v1/execution/agents/{agent_id} agent config, scope, and on-chain registration record
MCP /v1/execution/mcp MCP server for external agents

MCP interface. External agents (tenant-authorized) connect via MCP and get bidirectional access to Brain: they can read entity subsets of the Wiki, contribute Raw artifacts (transcripts, documents, structured observations) that flow through the extraction pipeline into agent-provenance-tagged Wiki entities, and propose actions that pass through Policy and Audit like any internal agent would. Every authorized third-party agent is registered on-chain in BrainMCPAgentRegistry with its scope attestation. The scope explicitly enumerates which of these three capabilities (read, contribute, propose) the tenant has granted. This is one of Brain's category-defining moves: shipping a bidirectional agent-contribution protocol in MVP, with cryptographic attribution of every contribution, signals that the agent-economy thesis is real and that Brain is positioned as the substrate agents route through.

Rails in MVP. Three rails, all first-class. (1) ACH via the tenant's existing bank API (Plaid Transfer as a fallback where direct bank integration isn't available). (2) ERP writeback to NetSuite. (3) On-chain execution to Base via the ERC-4337 BrainSmartAccount pattern with session keys and policy guard (see contracts). Card rails, wire rails, international rails are post-MVP.

### Layer 5: Audit (Proof)

What it does. Append-only log of every meaningful event. Tamper-evident via Merkle anchoring. Exportable in auditor-friendly formats.

Data model.

audit_events (
 id UUID PK,
 tenant_id UUID NOT NULL,
 layer TEXT NOT NULL, -- raw | wiki | policy | execution
 actor TEXT NOT NULL, -- agent ID, human user ID, api_partner ID
 action TEXT NOT NULL,
 inputs JSONB NOT NULL, -- hashes and evidence refs, not full content
 outputs JSONB NOT NULL,
 policy_version INT,
 event_hash BYTEA NOT NULL, -- deterministic hash of the canonical serialization
 prev_event_hash BYTEA, -- hash chain per tenant
 created_at TIMESTAMPTZ DEFAULT now(),
 INDEX (tenant_id, created_at)
)

audit_anchors (
 id UUID PK,
 tenant_id UUID NOT NULL,
 merkle_root BYTEA NOT NULL,
 event_count INT NOT NULL,
 period_start TIMESTAMPTZ,
 period_end TIMESTAMPTZ,
 onchain_tx_hash BYTEA, -- Base L2 tx where root was published
 onchain_block_number BIGINT,
 created_at TIMESTAMPTZ DEFAULT now()
)

Public API.

GET /v1/audit/events query by filter
GET /v1/audit/event/{id} record + inclusion proof
POST /v1/audit/export {format, range} → job
GET /v1/audit/anchor/latest latest on-chain anchor
GET /v1/audit/verify verify inclusion against on-chain root

Anchoring cadence in MVP. Hourly for all tenants. Per-event anchoring is a post-MVP enterprise feature.

Export formats in MVP. JSONL and CSV. SOX-ready PDF is post-MVP, JSONL + a schema doc is sufficient for most audit and regulator workflows.

## 4. Smart contracts

Four contracts in MVP, deployed to Base. Each is justified by a property that cannot be achieved off-chain.

### BrainAuditAnchor

Publishes per-tenant Merkle roots to Base. Anyone can verify that an audit record was included in a root that was published at a given block height, without trusting Brain.

contract BrainAuditAnchor {
 event AnchorPublished(
 bytes32 indexed tenantId,
 bytes32 root,
 uint256 eventCount,
 uint256 periodStart,
 uint256 periodEnd
 );

 function anchor(
 bytes32 tenantId,
 bytes32 root,
 uint256 eventCount,
 uint256 periodStart,
 uint256 periodEnd
 ) external onlyPublisher;

 function verifyInclusion(
 bytes32 root,
 bytes32 leaf,
 bytes32[] calldata proof
 ) external pure returns (bool);

 function latestAnchor(bytes32 tenantId)
 external view returns (bytes32 root, uint256 blockNumber);
}

Publisher role is a 2-of-3 multi-sig. Contract is non-upgradable after audit.

### BrainPolicyRegistry

Registers the hash and signer set of enterprise policies at the time they go into force. Lets a third party verify which policy was actually active on a given date, independent of Brain's database.

contract BrainPolicyRegistry {
 event PolicyRegistered(
 bytes32 indexed tenantId,
 uint256 indexed version,
 bytes32 policyHash,
 address[] signers,
 uint256 activatedAt
 );

 function registerPolicy(
 bytes32 tenantId,
 uint256 version,
 bytes32 policyHash,
 address[] calldata signers,
 bytes[] calldata signatures
 ) external;

 function getPolicy(bytes32 tenantId, uint256 version)
 external view returns (bytes32 hash, address[] memory signers, uint256 activatedAt);
}

Enterprise-tier tenants only. SMB/consumer policies stay off-chain.

### BrainSmartAccount

The on-chain execution pattern for the payment-agent. An ERC-4337 smart account owned by the tenant, with a revocable session key granted to Brain's payment-agent. Every on-chain action is pre-checked against the policy fingerprint in BrainPolicyRegistry and emits an event consumable by the Audit layer.

contract BrainSmartAccount {
 // Session key module: grants scoped, time-bound keys to Brain agents
 struct SessionKey {
 address holder; // Brain's agent address
 uint256 validAfter;
 uint256 validUntil;
 address[] allowedTargets; // contracts the key can call
 bytes4[] allowedSelectors; // function selectors it can invoke
 uint256 maxPerTx; // per-transaction amount cap
 uint256 maxPerPeriod; // cumulative cap per period
 bytes32 policyVersion; // must match BrainPolicyRegistry active version
 }

 event SessionKeyGranted(address indexed holder, bytes32 policyVersion, uint256 validUntil);
 event SessionKeyRevoked(address indexed holder);
 event AgentActionExecuted(
 bytes32 indexed tenantId,
 bytes32 indexed agentId,
 bytes32 policyVersion,
 address target,
 bytes4 selector,
 uint256 amount,
 bytes32 calldataHash
 );

 // Tenant root-key operations (hardware wallet / institutional custody)
 function grantSessionKey(SessionKey calldata key) external onlyOwner;
 function revokeSessionKey(address holder) external onlyOwner;

 // Brain agent execution (gated by policy guard)
 function executeViaSessionKey(
 address target,
 uint256 value,
 bytes calldata data
 ) external returns (bytes memory result);
}

The tenant's root key can revoke any session key instantly. Brain's agent cannot execute outside the session key's declared scope under any circumstance. This is the pattern that makes on-chain agent execution acceptable to both security teams and regulators.

### BrainMCPAgentRegistry

Public registry of third-party agents authorized to connect to a tenant's MCP interface. On-chain scope attestation means any observer can verify which agents have which permissions without trusting Brain's off-chain records.

contract BrainMCPAgentRegistry {
 struct AgentRegistration {
 bytes32 agentId; // unique agent identifier
 address agentAddress; // agent's signing key
 bytes32 tenantId; // authorizing tenant
 bytes32 scopeHash; // hash of canonical scope document
 uint256 registeredAt;
 uint256 revokedAt; // 0 if active
 }

 event AgentRegistered(
 bytes32 indexed agentId,
 address indexed agentAddress,
 bytes32 indexed tenantId,
 bytes32 scopeHash
 );
 event AgentRevoked(bytes32 indexed agentId, bytes32 indexed tenantId);

 function registerAgent(
 bytes32 agentId,
 address agentAddress,
 bytes32 tenantId,
 bytes32 scopeHash,
 bytes calldata tenantSignature // EIP-712 signature from tenant authorizing this scope
 ) external;

 function revokeAgent(bytes32 agentId, bytes calldata tenantSignature) external;

 function isAuthorized(bytes32 agentId, bytes32 tenantId) external view returns (bool);
 function getAgent(bytes32 agentId) external view returns (AgentRegistration memory);
}

Third-party agents cannot self-register. Registration requires an EIP-712 signature from the tenant that authorizes the specific scope. The scope document itself stays off-chain; only its hash is anchored. The canonical scope document enumerates three capability grants: wiki:read (which entity kinds the agent can query), raw:write (whether the agent can contribute Raw artifacts), and execution:propose (which action types the agent can propose). A tenant grants any subset. Most agents will have wiki:read plus either raw:write or execution:propose; few will have all three. This keeps the registry cheap (single hash per agent) while preserving verifiability and fine-grained per-capability revocation.

### What's deferred

Any Brain-native token: not until post-PMF, per the business plan's own sequencing.

## 5. What's out of scope for MVP

Being explicit here matters. Investors will ask what the MVP doesn't do; this is the answer.

Graph database. Postgres + recursive CTEs + pgvector handle MVP-scale queries.

Consumer surface. Business is the Y1 revenue anchor ($24M of the $30M target). Consumer is Phase 2 per the business plan and not required for the Series A story.

On-premise / customer-cloud deployment. Shared cloud only.

Multi-region. Single region (East US) with cross-region backups.

Every source adapter except the five listed under Raw.

Every agent except the three listed under Execution.

Every rail except ACH, ERP writeback, and optional Base on-chain.

Every export format except JSONL/CSV.

SOC 2 Type 2. Target Type 1 in MVP, Type 2 within 12 months of launch.

## 6. What the MVP proves

Investor-facing, three claims the MVP must defend:

The five-layer stack works end to end. A design partner can connect their bank + ERP, get a continuously compiled financial memory, author a policy, have an agent propose and execute a payment under that policy, and export a tamper-evident audit record, all through Brain's API, in under 30 days of onboarding.

The compounding moat is real. Every day a design partner is on Brain, their Wiki gets measurably richer: more entities, denser relations, higher average confidence on derived facts, more human-confirmed corrections feeding back into extraction quality. This is measurable and shown on a single chart in the investor deck.

External agents work under the same rules. An external agent connects via MCP, reads the Wiki, proposes an action, gets gated by Policy, executed through the tenant's rails, and logged in Audit, no different from an internal Brain agent. This is what makes Brain a protocol and not just a product.

Those three claims close the Series A. Everything in MVP serves them; everything cut from MVP doesn't.

## 7. Team and sequencing

Against the $4M seed's $2M product + engineering allocation:

1 engineering lead (full-stack TS/Python, infra literate)

2 backend engineers (one owns Raw + Wiki, one owns Policy + Execution + Audit)

1 ML/LLM engineer (owns extractors + /wiki/question + agent reasoning)

1 smart contracts engineer (contractor or full-time; ~14 to 16 weeks to ship four contracts + audit)

1 design partner success engineer (pre-sales, integration, feedback loop to product)

Six people, ~15 months of runway. Ships MVP in 6 months, lands 15 to 25 design partners in months 6 to 12, converts a subset to paid in months 9 to 15, closes Series A on the back of that revenue + the three proof points above.

## 8. What we build next (not now)

Signaled here for the investor conversation, not scoped for MVP:

Graph substrate as a read-side view (Apache AGE or Neo4j) when query patterns demand it

Additional agent types (treasury, FX, payroll, tax, on-chain yield)

Consumer surface

Institutional API tier with committed-volume contracts

Geographic expansion (SEPA, UPI, Pix adapters)

Bring-Your-Own-Source (BYOS) adapter framework: a published SDK that lets developers author tenant-facing ingestion adapters for sources Brain does not have first-party support for (Slack, Teams, vertical CRMs, custom internal systems). Adapters authenticate against Brain, stream data in Brain's Raw schema, and rely on Brain's extraction pipeline. Deferred because the regulatory and compliance surface expands materially when arbitrary developer code is inside the ingestion path.

Cross-tenant agent memory (with explicit tenant-consent flow and anonymization guarantees): lets an agent operating across multiple tenants contribute anonymized signals from tenant A that improve reasoning quality for tenant B, while preserving data sovereignty. Requires a governance and legal framework that does not exist at MVP.

Franchise / white-label tier

Native coordination token

End of MVP blueprint v0.2. The next artifact is the 6-month engineering plan decomposing Phase 1 into weekly milestones.

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (API) + Python (extractors, agents) | TS for correctness in the API boundary; Python for LLM ergonomics |
| Runtime | Node 22 LTS, Python 3.12 | Standard |
| Primary data store | Postgres 16 | Covers Raw manifest, Wiki, Policy, Audit. Row-level security for tenant isolation |
| Object store | Azure Blob Storage with immutable blob policy | Immutable Raw artifacts |
| Cache / queue | Redis | Sessions, rate limits, background job queue |
| Background jobs | BullMQ on Redis | Extraction pipeline, agent orchestration |
| LLM | Claude (extraction, reasoning) + OpenAI (fallback, embeddings) | Primary/secondary for redundancy |
| Embeddings | pgvector extension | Keeps vector search inside Postgres. No extra system |
| Infra | Azure (East US + West US 3) | Standard |
| Container orchestration | Azure Container Apps | Skip AKS until we need it |
| IaC | Terraform | Standard |
| Monitoring | Datadog | One tool, not five |
| Smart contracts | Solidity + Foundry, deployed to Base | Low-cost L2, EVM standard |
