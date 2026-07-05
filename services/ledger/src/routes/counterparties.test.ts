import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newCounterpartyId,
  newTenantId,
  newUserId,
  type Counterparty,
  type Principal,
  type Scope,
} from "@brain/shared";
import { registerLedgerRoutes } from "./index.js";
import type { LedgerService } from "../service/LedgerService.js";

const tenantId = newTenantId();

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: overrides.id ?? newUserId(),
    type: overrides.type ?? "user",
    tenantId,
    scopes: (overrides.scopes ?? ["ledger:read", "ledger:write"]) as Scope[],
    tokenId: "tok_ledger_routes",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function buildApp(service: Partial<LedgerService>, p: Principal = principal()) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.principal = p;
  });
  await registerLedgerRoutes(app, service as LedgerService);
  return app;
}

describe("counterparty routes", () => {
  const counterpartyId = newCounterpartyId();

  it("creates manual counterparties with server-derived provenance", async () => {
    const counterparty: Counterparty = {
      id: "cp_manual",
      owner_id: tenantId,
      name: "Acme",
      normalized_name: "acme",
      type: "vendor",
      risk_level: null,
      verified_status: "unverified",
      aliases: [],
      linked_accounts: [],
      agent_id: null,
      onchain_address: null,
      metadata: {},
      source_ids: [],
      evidence_ids: [],
      provenance: "human_confirmed",
      confidence: 0.95,
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
    };
    const createManualCounterparty = vi.fn(async () => ({
      counterparty,
      created: true,
      merged: false,
    }));
    const app = await buildApp({ createManualCounterparty });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ledger/counterparties",
        payload: {
          name: "Acme",
          type: "vendor",
          provenance: "agent_contributed",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.reason).toBe("field_not_editable");

      const ok = await app.inject({
        method: "POST",
        url: "/ledger/counterparties",
        payload: { name: "Acme", type: "vendor", country: "AE" },
      });
      expect(ok.statusCode).toBe(201);
      expect(createManualCounterparty).toHaveBeenCalledWith(
        expect.objectContaining({ principalType: "user" }),
        expect.objectContaining({ name: "Acme", type: "vendor", country: "AE" }),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects payment fields on create", async () => {
    const app = await buildApp({ createManualCounterparty: vi.fn() });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ledger/counterparties",
        payload: { name: "Acme", type: "vendor", iban: "AE070331234567890123456" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.reason).toBe("payment_fields_not_allowed");
    } finally {
      await app.close();
    }
  });

  it("requires ledger write scope for create", async () => {
    const app = await buildApp(
      { createManualCounterparty: vi.fn() },
      principal({ scopes: ["ledger:read"] }),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/ledger/counterparties",
        payload: { name: "Acme", type: "vendor" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("auth_scope_insufficient");
    } finally {
      await app.close();
    }
  });

  it("rejects agent principals on identity edit before service mutation", async () => {
    const updateCounterpartyIdentity = vi.fn();
    const app = await buildApp(
      { updateCounterpartyIdentity },
      principal({ id: "agent_01ARZ3NDEKTSV4RRFFQ69G5FAV", type: "agent" }),
    );
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/ledger/counterparties/${counterpartyId}`,
        payload: { name: "Acme New" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toMatchObject({
        reason: "actor_unresolved",
        principal_type: "agent",
      });
      expect(updateCounterpartyIdentity).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects trust and payment fields on edit", async () => {
    const app = await buildApp({ updateCounterpartyIdentity: vi.fn() });
    try {
      const trust = await app.inject({
        method: "PATCH",
        url: `/ledger/counterparties/${counterpartyId}`,
        payload: { verified_status: "sanctions_cleared" },
      });
      expect(trust.statusCode).toBe(400);
      expect(trust.json().error.details.reason).toBe("field_not_editable");

      const payment = await app.inject({
        method: "PATCH",
        url: `/ledger/counterparties/${counterpartyId}`,
        payload: { bank_account: "123" },
      });
      expect(payment.statusCode).toBe(400);
      expect(payment.json().error.details.reason).toBe("payment_fields_not_allowed");
    } finally {
      await app.close();
    }
  });
});
