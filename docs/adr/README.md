# Architecture Decision Records

Each ADR records one load-bearing decision: the context that forced it, the
decision itself, the consequences, and (critically for this codebase) **what
enforces it** so the decision cannot silently rot. These are the decisions a
technical reviewer or new engineer needs to understand before changing anything
on the money path.

Format: a lightweight MADR variant (Status, Context, Decision, Consequences,
Enforced by). Status is `Accepted` unless noted. ADRs are append-only in spirit:
supersede with a new ADR rather than rewriting history.

| ADR                                              | Decision                                      |
| ------------------------------------------------ | --------------------------------------------- |
| [0001](./0001-paymentintent-only-money-path.md)  | PaymentIntent is the only money path          |
| [0002](./0002-mcp-propose-not-execute.md)        | MCP can propose but never execute             |
| [0003](./0003-policy-is-deterministic.md)        | Policy is deterministic, never an LLM         |
| [0004](./0004-source-provenance-required.md)     | Source provenance is required on derived data |
| [0005](./0005-rls-role-separation.md)            | RLS role separation enforces tenant isolation |
| [0006](./0006-onchain-audit-anchoring.md)        | The audit log is anchored on-chain            |
| [0007](./0007-external-audit-gates-mainnet.md)   | The external contract audit gates mainnet     |
| [0008](./0008-demo-prod-separation.md)           | Demo and production are strictly separated    |
| [0009](./0009-agents-need-scoped-permissions.md) | Agents hold scoped, attested permissions      |
