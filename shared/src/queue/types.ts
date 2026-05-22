/**
 * Brain queue primitives built on BullMQ.
 *
 * §2 of Brain_MVP_Architecture: BullMQ on Redis. Used for the extraction
 * pipeline (§3 Layer 1→2), agent orchestration (§3 Layer 4), and the audit
 * anchor publisher (§3 Layer 5).
 *
 * Queue names are centralized here; never construct by string at the call
 * site. Changing a queue name is a data-migration event.
 */

export const QUEUE_NAMES = {
  rawExtract: "brain.raw.extract",
  rawWebhookIngest: "brain.raw.webhook_ingest",
  auditAnchor: "brain.audit.anchor",
  agentReconcile: "brain.agent.reconcile",
  agentPayment: "brain.agent.payment",
  agentAnomaly: "brain.agent.anomaly",
  agentRoute: "brain.agent.route",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Default job opts shared across the codebase. */
export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 } as const,
  removeOnComplete: { count: 1_000 }, // keep last N for debugging
  removeOnFail: { count: 10_000 },
};

/** Common job payload envelope — every job should carry at least these. */
export interface BrainJobEnvelope<T> {
  tenantId: string;
  requestId?: string;
  traceId?: string;
  payload: T;
}
