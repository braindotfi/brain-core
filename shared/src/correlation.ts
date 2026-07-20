import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEmitter } from "./audit/emitter.js";
import type { AuditEvent, AuditEventInput } from "./audit/types.js";

const storage = new AsyncLocalStorage<string>();

export function enterCorrelationId(correlationId: string): void {
  storage.enterWith(correlationId);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}

export class CorrelatingAuditEmitter implements AuditEmitter {
  public constructor(private readonly inner: AuditEmitter) {}

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    const correlationId = event.correlationId ?? currentCorrelationId();
    return this.inner.emit({
      ...event,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }
}
