/**
 * @brain/agent-router — multi-agent router for the Agent layer.
 *
 * Selects an internal/external agent for an event or intent and returns a
 * routing decision. Routes; never executes. The selected agent proposes
 * through the existing /v1/agents/{id}/propose path.
 */

export * from "./types.js";
export * from "./intent-classifier.js";
export * from "./embedding-classifier.js";
export * from "./intent-decomposer.js";
export * from "./evidence-gatherer.js";
export { AgentRouter, type AgentRouterDeps } from "./router.js";
export {
  ActionResolver,
  REQUESTED_ACTION_KEY,
  type ActionResolverDeps,
  type ActionResolution,
  type ActionResolutionInput,
  type ActionSource,
} from "./action-resolver.js";
export { registerAgentRouterRoutes, type AgentRouterRouteDeps } from "./route.js";
export {
  AgentRunService,
  type AgentRunServiceDeps,
  type AgentRunResult,
  type AgentRunStore,
  type RecordRunInput,
  type RecordRoutingDecisionInput,
} from "./agent-run-service.js";
export { registerAgentApiRoutes, type AgentApiDeps, type AgentApiReadStore } from "./agent-api.js";
export {
  StaticPromotionPolicy,
  ALL_SHADOWED,
  type PromotionPolicy,
  type PromotionConfig,
} from "./promotion.js";
export { LIVE_AGENTS } from "./promotion-config.js";
export {
  routeAndPropose,
  createAgentRouteWorker,
  type RouteAndProposeDeps,
  type RouteAndProposeResult,
  type AgentRouteWorkerDeps,
} from "./worker.js";

// The internal-agent catalog, handler contract, and registration payloads now
// live in @brain/internal-agents; import them from there.
