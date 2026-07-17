import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newAgentProposalId,
  newTenantId,
  requestIdPlugin,
  type AuditEmitter,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerProposalRoutes } from "./routes.js";
import { ActorResolver } from "../members/ActorResolver.js";
import type { MemberAuthority, MemberLookup } from "../members/types.js";
import type { AgentProposalRow } from "./repository.js";
import {
  registerPaymentIntentRoutes,
  type PaymentIntentAgentResolver,
} from "../payment-intents/routes.js";
import type { PaymentIntentService } from "../payment-intents/PaymentIntentService.js";
import type { AgentRow } from "../repository.js";

const TENANT = newTenantId();
const APPROVER_ID = "usr_approver";
const AGENT_PRINCIPAL_ID = "agent_demo";

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: APPROVER_ID,
    type: "user",
    tenantId: TENANT,
    scopes: ["execution:read", "execution:admin"],
    tokenId: "tok_1",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

function member(): MemberAuthority {
  return {
    id: APPROVER_ID,
    tenantId: TENANT,
    email: "approver@example.com",
    displayName: "Approver",
    role: "approver",
    status: "active",
    active: true,
    approvalDomains: ["ap"],
    perItemLimitCents: 1_000_000_00n,
    requiresSecondApproverAboveCents: null,
  };
}

function memberLookup(): MemberLookup {
  return {
    findMemberById: async (_tenantId, id) => (id === APPROVER_ID ? member() : null),
    findMemberByEmail: async () => null,
    findMemberByIdentityLink: async () => null,
  };
}

function seedRow(overrides: Partial<AgentProposalRow> = {}): AgentProposalRow {
  return {
    id: newAgentProposalId(),
    tenant_id: TENANT,
    type: "vendor_risk",
    agent_principal: "agent_seed",
    risk_band: "elevated",
    execution_mode: "propose",
    status: "needs_review",
    title: "Test proposal",
    amount: "100.00",
    confidence: "0.9",
    narrative: "narrative",
    evidence: [{ text: "evidence" }],
    links: {},
    policy_decision_id: null,
    reversible: false,
    decision: null,
    decision_edit: null,
    decided_by: null,
    decided_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

/**
 * Minimal in-memory fake of the `agent_proposals` table, tailored to exactly
 * the query shapes `services/execution/src/proposals/repository.ts` emits.
 * `raceOnId`, when set, mutates the stored row's status to "rejected"
 * immediately after the get-by-id SELECT returns its snapshot, simulating a
 * concurrent decide winning the race between this request's read and its
 * compare-and-swap write.
 */
function fakePool(store: Map<string, AgentProposalRow>, opts: { raceOnId?: string } = {}): Pool {
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(t) || /set_config/i.test(t)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT \* FROM agent_proposals WHERE id = \$1/i.test(t)) {
        const id = values[0] as string;
        const row = store.get(id);
        if (row === undefined) return { rows: [], rowCount: 0 };
        const snapshot = { ...row };
        if (opts.raceOnId === id) row.status = "rejected";
        return { rows: [snapshot], rowCount: 1 };
      }
      if (/^SELECT \* FROM agent_proposals/i.test(t)) {
        let idx = 0;
        const statusFilter = t.includes("status = $") ? (values[idx++] as string) : undefined;
        const typeFilter = t.includes("type = $") ? (values[idx++] as string) : undefined;
        const limit = values[idx] as number;
        let rows = [...store.values()];
        if (statusFilter !== undefined) rows = rows.filter((r) => r.status === statusFilter);
        if (typeFilter !== undefined) rows = rows.filter((r) => r.type === typeFilter);
        rows = rows
          .slice()
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, limit);
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE agent_proposals/i.test(t)) {
        const hasAmount = t.includes("amount = $6");
        const status = values[0] as AgentProposalRow["status"];
        const decision = values[1] as AgentProposalRow["decision"];
        const decisionEditRaw = values[2] as string;
        const decidedBy = values[3] as string;
        const id = values[4] as string;
        const amount = hasAmount ? (values[5] as string) : undefined;
        const expectedStatus = (hasAmount ? values[6] : values[5]) as AgentProposalRow["status"];
        const row = store.get(id);
        if (row === undefined || row.status !== expectedStatus) {
          return { rows: [], rowCount: 0 };
        }
        row.status = status;
        row.decision = decision;
        row.decision_edit = JSON.parse(decisionEditRaw) as AgentProposalRow["decision_edit"];
        row.decided_by = decidedBy;
        row.decided_at = new Date();
        if (amount !== undefined) row.amount = amount;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      throw new Error(`fakePool: unhandled query: ${t}`);
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

async function buildApp(
  pool: Pool,
  audit: AuditEmitter,
  scopes: Scope[] = ["execution:read", "execution:admin"],
  principalType: Principal["type"] = "user",
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = principal({
      scopes,
      type: principalType,
      id: principalType === "agent" ? AGENT_PRINCIPAL_ID : APPROVER_ID,
    });
  });
  const actorResolver = new ActorResolver({ members: memberLookup() });
  await registerProposalRoutes(app, { pool, audit, actorResolver });
  return app;
}

function fakeAudit(): AuditEmitter & { emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(async (e: Record<string, unknown>) => ({
    ...e,
    id: "evt_1",
    createdAt: "now",
  }));
  return { emit } as unknown as AuditEmitter & { emit: typeof emit };
}

describe("GET /proposals", () => {
  it("lists with status and type filters", async () => {
    const store = new Map<string, AgentProposalRow>();
    const a = seedRow({ status: "needs_review", type: "vendor_risk" });
    const b = seedRow({ status: "approved", type: "treasury" });
    store.set(a.id, a);
    store.set(b.id, b);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({ method: "GET", url: "/proposals?status=needs_review" });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toHaveLength(1);
    expect(res.json().proposals[0].id).toBe(a.id);
    await app.close();
  });

  it("rejects an unknown status filter", async () => {
    const app = await buildApp(fakePool(new Map()), fakeAudit());

    const res = await app.inject({ method: "GET", url: "/proposals?status=bogus" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_params_invalid");
    await app.close();
  });

  it("requires execution:read", async () => {
    const app = await buildApp(fakePool(new Map()), fakeAudit(), []);

    const res = await app.inject({ method: "GET", url: "/proposals" });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
    await app.close();
  });
});

describe("GET /proposals/:id", () => {
  it("rejects a malformed id", async () => {
    const app = await buildApp(fakePool(new Map()), fakeAudit());

    const res = await app.inject({ method: "GET", url: "/proposals/not-an-id" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_params_invalid");
    await app.close();
  });

  it("404s on an unknown id", async () => {
    const app = await buildApp(fakePool(new Map()), fakeAudit());

    const res = await app.inject({ method: "GET", url: `/proposals/${newAgentProposalId()}` });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_proposal_not_found");
    await app.close();
  });

  it("returns the full serialization", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow();
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({ method: "GET", url: `/proposals/${row.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: row.id, narrative: "narrative", reversible: false });
    await app.close();
  });
});

describe("POST /proposals/:id/decide", () => {
  it("approves a needs_review propose-mode proposal", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "needs_review", execution_mode: "propose" });
    store.set(row.id, row);
    const audit = fakeAudit();
    const app = await buildApp(fakePool(store), audit);

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().decided_by).toBe(APPROVER_ID);

    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "proposal.decided",
        inputs: { type: row.type },
        outputs: { decision: "approved", proposal_id: row.id },
      }),
    );
    await app.close();
  });

  it("acknowledges a needs_review notify_only proposal", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "needs_review", execution_mode: "notify_only" });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "acknowledged" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("acknowledged");
    await app.close();
  });

  it("undoes a reversible approved proposal back to review, then re-approves", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "approved", execution_mode: "propose", reversible: true });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const undone = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "undone_to_review" },
    });
    expect(undone.statusCode).toBe(200);
    expect(undone.json().status).toBe("undone_to_review");

    const reapproved = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(reapproved.statusCode).toBe(200);
    expect(reapproved.json().status).toBe("approved");
    await app.close();
  });

  it("requires execution:admin", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow();
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit(), ["execution:read"]);

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
    await app.close();
  });

  it("rejects an unrecognized decision value", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow();
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "bogus" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("rejects a non-decimal edit.amount", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "needs_review", execution_mode: "propose" });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved", edit: { amount: "not-a-number" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_body_invalid");
    await app.close();
  });

  it("404s on an unknown id", async () => {
    const app = await buildApp(fakePool(new Map()), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${newAgentProposalId()}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("agent_proposal_not_found");
    await app.close();
  });

  it("an agent principal cannot decide (actor_unresolved)", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow();
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit(), ["execution:admin"], "agent");

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.details).toMatchObject({
      reason: "actor_unresolved",
      source: "session",
      principal_type: "agent",
    });
    await app.close();
  });

  it("ignores a spoofed payload actor field", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "needs_review", execution_mode: "propose" });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved", actor_id: "usr_someone_else" },
    });

    expect(res.statusCode).toBe(200);
    // Session identity always wins: decided_by is the authenticated principal.
    expect(res.json().decided_by).toBe(APPROVER_ID);
    await app.close();
  });

  it("rejects an illegal transition (already terminal)", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "rejected" });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_proposal_invalid_state");
    await app.close();
  });

  it("returns 409 on a lost compare-and-swap race", async () => {
    const store = new Map<string, AgentProposalRow>();
    const row = seedRow({ status: "needs_review", execution_mode: "propose" });
    store.set(row.id, row);
    const app = await buildApp(fakePool(store, { raceOnId: row.id }), fakeAudit());

    const res = await app.inject({
      method: "POST",
      url: `/proposals/${row.id}/decide`,
      payload: { decision: "approved" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_proposal_invalid_state");
    await app.close();
  });
});

describe("GET /payment-intents/:id?expand=agent", () => {
  const PI_ID = "pi_01TEST00000000000000000000";

  function fakeIntent(agentId: string | null): Record<string, unknown> {
    return { id: PI_ID, status: "proposed", created_by_agent_id: agentId };
  }

  function buildPaymentIntentApp(
    intent: Record<string, unknown>,
    resolveAgent?: PaymentIntentAgentResolver,
  ): Promise<FastifyInstance> {
    return (async () => {
      const app = Fastify();
      await app.register(requestIdPlugin);
      await app.register(errorHandlerPlugin);
      app.addHook("preHandler", async (req) => {
        req.principal = principal({ scopes: ["execution:read"] });
      });
      const service = { get: async () => intent } as unknown as PaymentIntentService;
      await registerPaymentIntentRoutes(app, service, undefined, resolveAgent);
      return app;
    })();
  }

  it("attaches the agent when expand=agent and the agent resolves", async () => {
    const agentRow: AgentRow = {
      id: "agent_1",
      tenant_id: TENANT,
      kind: "internal",
      role: "payment",
      display_name: "Demo Payment Agent",
      scope_hash: null,
      onchain_address: null,
      state: "active",
      registered_tx: null,
      registered_at: null,
      created_at: new Date(),
    };
    const resolveAgent: PaymentIntentAgentResolver = async () => agentRow;
    const app = await buildPaymentIntentApp(fakeIntent("agent_1"), resolveAgent);

    const res = await app.inject({ method: "GET", url: `/payment-intents/${PI_ID}?expand=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toMatchObject({
      id: "agent_1",
      display_name: "Demo Payment Agent",
      kind: "internal",
      role: "payment",
      state: "active",
    });
    await app.close();
  });

  it("attaches agent: null when the lookup misses", async () => {
    const resolveAgent: PaymentIntentAgentResolver = async () => null;
    const app = await buildPaymentIntentApp(fakeIntent("agent_missing"), resolveAgent);

    const res = await app.inject({ method: "GET", url: `/payment-intents/${PI_ID}?expand=agent` });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeNull();
    await app.close();
  });

  it("leaves the response unchanged when expand is absent", async () => {
    const resolveAgentMock = vi.fn(async () => null);
    const app = await buildPaymentIntentApp(
      fakeIntent("agent_1"),
      resolveAgentMock as unknown as PaymentIntentAgentResolver,
    );

    const res = await app.inject({ method: "GET", url: `/payment-intents/${PI_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeUndefined();
    expect(resolveAgentMock).not.toHaveBeenCalled();
    await app.close();
  });
});
