/**
 * @brain/agent-router — multi-agent router for the Agent layer.
 *
 * Selects an internal/external agent for an event or intent and returns a
 * routing decision. Routes; never executes. The selected agent proposes
 * through the existing /v1/agents/{id}/propose path.
 */

export * from "./types.js";
export * from "./intent-classifier.js";
export * from "./evidence-gatherer.js";
export { AgentRouter, type AgentRouterDeps } from "./router.js";
export { registerAgentRouterRoutes, type AgentRouterRouteDeps } from "./route.js";
export * from "./agents/handler.js";
export { internalAgentCatalog, internalAgentHandlers } from "./agents/registry.js";
export {
  routeAndPropose,
  createAgentRouteWorker,
  type RouteAndProposeDeps,
  type RouteAndProposeResult,
  type AgentRouteWorkerDeps,
} from "./worker.js";
export * from "./registration.js";
