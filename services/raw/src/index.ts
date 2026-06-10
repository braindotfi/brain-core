/**
 * @brain/raw
 *
 * Ingestion workers. Immutable artifact store, content-addressed, per-source
 * adapters. Implements 5 endpoints from Brain_API_Specification.yaml §Raw.
 */

export const SERVICE_NAME = "brain-raw" as const;

export {
  buildRawApp,
  registerRawPlugin,
  type BuildRawAppOptions,
  type RegisterRawPluginOptions,
} from "./server.js";
export type { RawDeps } from "./deps.js";
export { ingestOne, ingestMany, type IngestInput, type IngestResult } from "./services/ingest.js";
export { INGEST_OPERATIONS, type IngestEnvelopeFields, type IngestOperation } from "./envelope.js";
export {
  startSyncWorker,
  runSyncCycle,
  type SyncWorker,
  type SyncWorkerDeps,
  type SyncWorkerOptions,
} from "./workers/syncWorker.js";
export {
  adapterForSourceType,
  adapterForWebhookProvider,
  descriptorForSourceType,
  listAdapters,
  listDescriptors,
} from "./adapters/registry.js";
export {
  CONNECTOR_DESCRIPTORS,
  type ConnectorDescriptor,
  type ConnectorCapabilities,
  type SourceCategory,
} from "./adapters/descriptors.js";

export {
  findArtifactById,
  tombstoneArtifact,
  type RawArtifactRow,
} from "./repository/artifacts.js";
export {
  listParsedByArtifact,
  type RawParsedRow,
  type ListParsedFilters,
} from "./repository/parsed.js";

export {
  SourceService,
  InMemorySourceRepository,
  type SourceRepository,
  type SourceCredentialStore,
} from "./sources/SourceService.js";
export {
  PostgresSourceRepository,
  type PostgresSourceRepositoryDeps,
} from "./sources/PostgresSourceRepository.js";
