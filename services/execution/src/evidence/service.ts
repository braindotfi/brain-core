import { randomUUID } from "node:crypto";
import {
  brainError,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { EvidenceBlobStore } from "./blob-store.js";
import { sha256Hex } from "./blob-store.js";
import {
  archiveExpiredStandardEvidence,
  findEvidenceById,
  hasOpenProposalAttachment,
  insertEvidence,
  linkEvidenceToProposal,
  listEvidence,
  softDeleteEvidence,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceRetentionClass,
} from "./repository.js";

const SIGNED_URL_TTL_SECONDS = 600;

export interface EvidenceUploadInput {
  kind: EvidenceKind;
  name: string;
  content: Buffer;
  mimeType: string;
  retentionClass?: EvidenceRetentionClass;
  metadata?: Record<string, unknown>;
  proposalId?: string;
}

export interface EvidenceExternalInput {
  name: string;
  url: string;
  metadata?: Record<string, unknown>;
  proposalId?: string;
}

export interface EvidenceGenerateInput {
  kind: "report" | "data";
  name: string;
  generator: string;
  inputRef?: string;
  metadata?: Record<string, unknown>;
  proposalId?: string;
}

export interface EvidenceReadResult {
  evidence: EvidenceRecord;
  signedUrl: string | null;
}

export class EvidenceStorageService {
  public constructor(
    private readonly pool: Pool,
    private readonly blob: EvidenceBlobStore,
    private readonly audit: AuditEmitter,
  ) {}

  public async upload(
    ctx: ServiceCallContext,
    input: EvidenceUploadInput,
  ): Promise<EvidenceReadResult> {
    const stored = await this.blob.put(input.content, {
      tenantId: ctx.tenantId,
      mimeType: input.mimeType,
    });
    const evidence = await withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const row = await insertEvidence(client, {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        kind: input.kind,
        name: input.name,
        source: "uploaded",
        storageRef: stored.storageRef,
        sha256: stored.sha256,
        mimeType: input.mimeType,
        byteSize: BigInt(stored.byteSize),
        capturedAt: new Date(),
        capturedBy: ctx.actor,
        retentionClass: input.retentionClass ?? "standard",
        metadata: input.metadata ?? {},
      });
      if (input.proposalId !== undefined) {
        await linkEvidenceToProposal(client, {
          tenantId: ctx.tenantId,
          proposalId: input.proposalId,
          evidenceId: row.id,
          sourceRef: { source: "upload" },
        });
      }
      return row;
    });
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "evidence.uploaded",
      inputs: { kind: input.kind },
      outputs: { evidence_id: evidence.id, sha256: evidence.sha256, byte_size: stored.byteSize },
    });
    return this.withUrl(evidence);
  }

  public async registerExternal(
    ctx: ServiceCallContext,
    input: EvidenceExternalInput,
  ): Promise<EvidenceReadResult> {
    const evidence = await withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const row = await insertEvidence(client, {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        kind: "external",
        name: input.name,
        source: "external_link",
        storageRef: input.url,
        sha256: null,
        mimeType: "text/uri-list",
        byteSize: 0n,
        capturedAt: new Date(),
        capturedBy: ctx.actor,
        retentionClass: "standard",
        metadata: input.metadata ?? {},
      });
      if (input.proposalId !== undefined) {
        await linkEvidenceToProposal(client, {
          tenantId: ctx.tenantId,
          proposalId: input.proposalId,
          evidenceId: row.id,
          sourceRef: { source: "external_link", url: input.url },
        });
      }
      return row;
    });
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "evidence.external_registered",
      inputs: { source: "external_link" },
      outputs: { evidence_id: evidence.id },
    });
    return this.withUrl(evidence);
  }

  public async generate(
    ctx: ServiceCallContext,
    input: EvidenceGenerateInput,
  ): Promise<EvidenceReadResult> {
    const body = Buffer.from(
      JSON.stringify({
        generator: input.generator,
        input_ref: input.inputRef ?? null,
        metadata: input.metadata ?? {},
        generated_at: new Date().toISOString(),
      }),
    );
    const stored = await this.blob.put(body, {
      tenantId: ctx.tenantId,
      mimeType: "application/json",
    });
    const evidence = await withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const row = await insertEvidence(client, {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        kind: input.kind,
        name: input.name,
        source: "generated",
        storageRef: stored.storageRef,
        sha256: stored.sha256,
        mimeType: "application/json",
        byteSize: BigInt(stored.byteSize),
        capturedAt: new Date(),
        capturedBy: ctx.actor,
        retentionClass: "compliance_7yr",
        metadata: {
          ...(input.metadata ?? {}),
          generator: input.generator,
          input_ref: input.inputRef ?? null,
        },
      });
      if (input.proposalId !== undefined) {
        await linkEvidenceToProposal(client, {
          tenantId: ctx.tenantId,
          proposalId: input.proposalId,
          evidenceId: row.id,
          sourceRef: { source: "generated", generator: input.generator },
        });
      }
      return row;
    });
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "evidence.generated",
      inputs: { kind: input.kind, generator: input.generator },
      outputs: { evidence_id: evidence.id, sha256: evidence.sha256 },
    });
    return this.withUrl(evidence);
  }

  public async get(ctx: ServiceCallContext, id: string): Promise<EvidenceReadResult> {
    const evidence = await withTenantScope(this.pool, ctx.tenantId, (client) =>
      findEvidenceById(client, id),
    );
    if (evidence === null || evidence.deletedAt !== null) {
      throw brainError("evidence_not_found", "evidence not found", { statusOverride: 404 });
    }
    await this.verify(ctx, evidence);
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "evidence.downloaded",
      inputs: { evidence_id: evidence.id },
      outputs: {},
    });
    return this.withUrl(evidence);
  }

  public async list(
    ctx: ServiceCallContext,
    input: {
      proposalId?: string;
      kind?: EvidenceKind;
      from?: Date;
      to?: Date;
      limit?: number;
    },
  ): Promise<EvidenceRecord[]> {
    const filters = {
      ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      limit: input.limit ?? 50,
    };
    return withTenantScope(this.pool, ctx.tenantId, (client) => listEvidence(client, filters));
  }

  public async delete(ctx: ServiceCallContext, id: string): Promise<EvidenceRecord> {
    const deleted = await withTenantScope(this.pool, ctx.tenantId, async (client) => {
      if (await hasOpenProposalAttachment(client, id)) {
        throw brainError("evidence_delete_blocked", "evidence is attached to an open proposal", {
          statusOverride: 409,
        });
      }
      return softDeleteEvidence(client, id, "user_requested");
    });
    if (deleted === null) {
      throw brainError("evidence_not_found", "evidence not found", { statusOverride: 404 });
    }
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "evidence.deleted",
      inputs: { evidence_id: id },
      outputs: { deleted_at: deleted.deletedAt?.toISOString() ?? null },
    });
    return deleted;
  }

  public async archiveExpiredStandard(
    ctx: ServiceCallContext,
    now: Date = new Date(),
  ): Promise<number> {
    const count = await withTenantScope(this.pool, ctx.tenantId, (client) =>
      archiveExpiredStandardEvidence(client, now),
    );
    if (count > 0) {
      await this.audit.emit({
        tenantId: ctx.tenantId,
        layer: "execution",
        actor: ctx.actor,
        action: "evidence.retention_archived",
        inputs: { retention_class: "standard" },
        outputs: { archived_count: count },
      });
    }
    return count;
  }

  private async verify(ctx: ServiceCallContext, evidence: EvidenceRecord): Promise<void> {
    if (evidence.sha256 === null) return;
    const body = await this.blob.get(evidence.storageRef);
    const observed = sha256Hex(body);
    if (observed === evidence.sha256) return;
    await this.audit.emit({
      tenantId: ctx.tenantId,
      layer: "execution",
      actor: ctx.actor,
      action: "tamper_detected",
      inputs: { evidence_id: evidence.id },
      outputs: { expected_sha256: evidence.sha256, observed_sha256: observed },
    });
    throw brainError("evidence_tamper_detected", "evidence content hash mismatch", {
      statusOverride: 409,
      details: { evidence_id: evidence.id },
    });
  }

  private async withUrl(evidence: EvidenceRecord): Promise<EvidenceReadResult> {
    const signedUrl =
      evidence.sha256 === null
        ? evidence.storageRef
        : await this.blob.signedUrl(evidence.storageRef, SIGNED_URL_TTL_SECONDS);
    return { evidence, signedUrl };
  }
}

export function evidenceToWire(result: EvidenceReadResult) {
  const row = result.evidence;
  return {
    id: row.id,
    tenant_id: row.tenantId,
    kind: row.kind,
    name: row.name,
    source: row.source,
    storage_ref: row.storageRef,
    sha256: row.sha256,
    mime_type: row.mimeType,
    byte_size: Number(row.byteSize),
    captured_at: row.capturedAt.toISOString(),
    captured_by: row.capturedBy,
    retention_class: row.retentionClass,
    metadata: row.metadata,
    archived_at: row.archivedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    signed_url: result.signedUrl,
  };
}

export function evidenceRecordToWire(row: EvidenceRecord) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    kind: row.kind,
    name: row.name,
    source: row.source,
    storage_ref: row.storageRef,
    sha256: row.sha256,
    mime_type: row.mimeType,
    byte_size: Number(row.byteSize),
    captured_at: row.capturedAt.toISOString(),
    captured_by: row.capturedBy,
    retention_class: row.retentionClass,
    metadata: row.metadata,
    archived_at: row.archivedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
