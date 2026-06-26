import type { AuditAnchor, AuditEvent } from "@brain/surfaces";
import type { AuditLog } from "../internal/services.js";

/**
 * Binds the surface AuditAnchor port to brain-core's immutable Audit log. The
 * approval pipeline calls this before any execution handoff, so a recorded
 * decision always precedes action. The contentHash carried here is the
 * emit-time hash and is the proof of what the approver saw.
 */
export class CoreAuditAnchor implements AuditAnchor {
  constructor(private readonly log: AuditLog) {}

  async record(event: AuditEvent): Promise<void> {
    await this.log.append(event);
  }
}
