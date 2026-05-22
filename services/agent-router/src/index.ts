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
export {
  routeAndPropose,
  createAgentRouteWorker,
  type RouteAndProposeDeps,
  type RouteAndProposeResult,
  type AgentRouteWorkerDeps,
} from "./worker.js";

// The internal-agent catalog, handler contract, and registration payloads now
// live in @brain/internal-agents; import them from there.
