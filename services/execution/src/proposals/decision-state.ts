import {
  brainError,
  isBrainId,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ProposalDecision } from "./decision-service.js";

const MAX_PROPOSAL_IDS = 100;

export interface ProposalDecisionStateQuery {
  proposal_ids: string[];
}

export type ProposalDecisionStateItem =
  | {
      proposal_id: string;
      found: true;
      decision_state: "pending" | "decided";
      status: string;
      decision: ProposalDecision | null;
      audit_id: string | null;
      decided_at: string | null;
    }
  | {
      proposal_id: string;
      found: false;
      decision_state: null;
      status: null;
      decision: null;
      audit_id: null;
      decided_at: null;
    };

export interface ProposalDecisionStateResult {
  states: ProposalDecisionStateItem[];
}

interface StoredDecisionState {
  proposal_id: string;
  status: string;
  decision: ProposalDecision | null;
  decision_audit_id: string | null;
  decided_at: Date | string | null;
}

export function parseProposalDecisionStateQuery(body: unknown): ProposalDecisionStateQuery {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidBody("request body must be an object");
  }
  const record = body as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter((key) => key !== "proposal_ids");
  if (unknownFields.length > 0) {
    throw brainError("request_body_invalid", "unknown_field", {
      details: { reason: "unknown_field", fields: unknownFields },
    });
  }
  const ids = record["proposal_ids"];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PROPOSAL_IDS) {
    throw invalidBody(`proposal_ids must contain between 1 and ${MAX_PROPOSAL_IDS} ids`);
  }
  if (!ids.every((id): id is string => typeof id === "string")) {
    throw invalidBody("every proposal_id must be a string");
  }
  const malformed = ids.filter((id) => !isBrainId(id, "prop") && !isBrainId(id, "pi"));
  if (malformed.length > 0) {
    throw invalidBody("every proposal_id must be a valid prop_ or pi_ id");
  }
  if (new Set(ids).size !== ids.length) {
    throw invalidBody("proposal_ids must be unique");
  }
  return { proposal_ids: ids };
}

export async function queryProposalDecisionStates(
  pool: Pool,
  ctx: ServiceCallContext,
  input: ProposalDecisionStateQuery,
): Promise<ProposalDecisionStateResult> {
  const proposalIds = input.proposal_ids.filter((id) => isBrainId(id, "prop"));
  const paymentIntentIds = input.proposal_ids.filter((id) => isBrainId(id, "pi"));

  const stored = await withTenantScope(pool, ctx.tenantId, async (client) => {
    const proposalRows = await queryProposalRows(client, proposalIds);
    const paymentIntentRows = await queryPaymentIntentRows(client, paymentIntentIds);
    return [...proposalRows, ...paymentIntentRows];
  });
  const byId = new Map(stored.map((row) => [row.proposal_id, row]));

  return {
    states: input.proposal_ids.map((proposalId) => {
      const row = byId.get(proposalId);
      if (row === undefined) return missingState(proposalId);
      return {
        proposal_id: row.proposal_id,
        found: true,
        decision_state: row.decision === null ? "pending" : "decided",
        status: row.status,
        decision: row.decision,
        audit_id: row.decision_audit_id,
        decided_at: row.decided_at === null ? null : isoDate(row.decided_at),
      };
    }),
  };
}

async function queryProposalRows(
  client: TenantScopedClient,
  ids: readonly string[],
): Promise<StoredDecisionState[]> {
  const { rows } = await client.query<StoredDecisionState>(
    `SELECT id AS proposal_id, status, decision, decision_audit_id, decided_at
       FROM proposals
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND id = ANY($1::text[])`,
    [ids],
  );
  return rows;
}

async function queryPaymentIntentRows(
  client: TenantScopedClient,
  ids: readonly string[],
): Promise<StoredDecisionState[]> {
  const { rows } = await client.query<StoredDecisionState>(
    `SELECT id AS proposal_id, status, decision, decision_audit_id, decided_at
       FROM ledger_payment_intents
      WHERE owner_id = current_setting('app.tenant_id', true)
        AND id = ANY($1::text[])`,
    [ids],
  );
  return rows;
}

function missingState(proposalId: string): ProposalDecisionStateItem {
  return {
    proposal_id: proposalId,
    found: false,
    decision_state: null,
    status: null,
    decision: null,
    audit_id: null,
    decided_at: null,
  };
}

function invalidBody(message: string): Error {
  return brainError("request_body_invalid", message);
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
