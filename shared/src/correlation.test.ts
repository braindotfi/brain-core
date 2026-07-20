import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "./audit/emitter.js";
import { CorrelatingAuditEmitter, enterCorrelationId } from "./correlation.js";

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
});
