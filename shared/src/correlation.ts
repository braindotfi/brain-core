import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEmitter } from "./audit/emitter.js";
import type { AuditEvent, AuditEventInput } from "./audit/types.js";

interface RequestAuditContext {
  correlationId?: string;
  keyId?: string;
  apiKeyAuditEventEmitted?: boolean;
}

const storage = new AsyncLocalStorage<RequestAuditContext>();

export function beginRequestAuditContext(correlationId: string): void {
  storage.enterWith({ correlationId });
}

export function enterCorrelationId(correlationId: string): void {
  const ctx = storage.getStore();
  if (ctx !== undefined) {
    ctx.correlationId = correlationId;
    return;
  }
  storage.enterWith({ correlationId });
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function enterApiKeyId(keyId: string): void {
  const ctx = storage.getStore();
  if (ctx !== undefined) {
    ctx.keyId = keyId;
    return;
  }
  storage.enterWith({ keyId });
}

export function currentApiKeyId(): string | undefined {
  return storage.getStore()?.keyId;
}

export function markApiKeyAuditEventEmitted(): void {
  const ctx = storage.getStore();
  if (ctx !== undefined) {
    ctx.apiKeyAuditEventEmitted = true;
    return;
  }
  storage.enterWith({ apiKeyAuditEventEmitted: true });
}

export function currentRequestHasApiKeyAuditEvent(): boolean {
  return storage.getStore()?.apiKeyAuditEventEmitted === true;
}

export class CorrelatingAuditEmitter implements AuditEmitter {
  public constructor(private readonly inner: AuditEmitter) {}

  public async emit(event: AuditEventInput): Promise<AuditEvent> {
    const correlationId = event.correlationId ?? currentCorrelationId();
    const keyId = event.keyId ?? currentApiKeyId();
    if (keyId !== undefined) {
      markApiKeyAuditEventEmitted();
    }
    return this.inner.emit({
      ...event,
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(keyId !== undefined ? { keyId } : {}),
    });
  }
}
