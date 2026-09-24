import type { ServiceCallContext } from "@brain/shared";
import type { Evidence } from "@brain/internal-agents";
import type { EvidenceStorageService } from "@brain/execution";
import type { EvidenceKind, EvidenceRetentionClass } from "@brain/execution";

export interface ScannerEvidenceArtifact {
  kind: EvidenceKind;
  name: string;
  body: Buffer;
  mimeType: string;
  retentionClass?: EvidenceRetentionClass;
  metadata?: Record<string, unknown>;
  proposalId?: string;
}

export interface ScannerExternalEvidence {
  name: string;
  url: string;
  metadata?: Record<string, unknown>;
  proposalId?: string;
}

export async function attachScannerArtifactEvidence(
  service: EvidenceStorageService,
  ctx: ServiceCallContext,
  input: ScannerEvidenceArtifact,
): Promise<Evidence> {
  const result = await service.upload(ctx, {
    kind: input.kind,
    name: input.name,
    content: input.body,
    mimeType: input.mimeType,
    ...(input.retentionClass !== undefined ? { retentionClass: input.retentionClass } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
  });
  return {
    kind: input.kind,
    ref: result.evidence.id,
    source_system: "evidence",
    object_type: input.kind,
    object_id: result.evidence.id,
    ...(result.evidence.sha256 !== null ? { hash: result.evidence.sha256 } : {}),
    timestamp: result.evidence.capturedAt.toISOString(),
  };
}

export async function attachScannerExternalEvidence(
  service: EvidenceStorageService,
  ctx: ServiceCallContext,
  input: ScannerExternalEvidence,
): Promise<Evidence> {
  const result = await service.registerExternal(ctx, {
    name: input.name,
    url: input.url,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
  });
  return {
    kind: "external",
    ref: result.evidence.id,
    source_system: "evidence",
    object_type: "external",
    object_id: result.evidence.id,
    timestamp: result.evidence.capturedAt.toISOString(),
  };
}
