import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "./audit/emitter.js";
import {
  CorrelatingAuditEmitter,
  currentRequestHasApiKeyAuditEvent,
  enterApiKeyId,
  enterCorrelationId,
} from "./correlation.js";

describe("CorrelatingAuditEmitter", () => {
  it("adds the current request correlation id to emitted audit events", async () => {
    const inner = new InMemoryAuditEmitter();
    const emitter = new CorrelatingAuditEmitter(inner);
    enterCorrelationId("req_client_1");

    const event = await emitter.emit({
      tenantId: "tnt_1",
      layer: "execution",
      actor: "user_1",
      action: "proposal.decided",
      inputs: { proposal_id: "prop_1" },
      outputs: { status: "acknowledged" },
    });

    expect(event.correlationId).toBe("req_client_1");
    expect(inner.events[0]?.correlationId).toBe("req_client_1");
  });

  it("marks the current request when an API-key-attributed audit event is emitted", async () => {
    const inner = new InMemoryAuditEmitter();
    const emitter = new CorrelatingAuditEmitter(inner);
    enterApiKeyId("akey_1");

    expect(currentRequestHasApiKeyAuditEvent()).toBe(false);

    await emitter.emit({
      tenantId: "tnt_1",
      layer: "audit",
      actor: "akey_1",
      action: "audit.test",
      inputs: {},
      outputs: {},
    });

    expect(currentRequestHasApiKeyAuditEvent()).toBe(true);
    expect(inner.events[0]?.keyId).toBe("akey_1");
  });
});
