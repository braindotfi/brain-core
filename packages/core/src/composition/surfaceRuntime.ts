import {
  SurfaceRegistry,
  Dispatcher,
  ApprovalService,
  SlackAdapter,
  TeamsAdapter,
  EmailAdapter,
  type SlackClient,
  type TeamsClient,
  type EmailClient,
  type SurfaceConfig,
} from "@brain/surfaces";
import type { CoreServices } from "../internal/services.js";
import { buildBrainCorePorts } from "../bindings/index.js";

/**
 * The composition root. This is the one place brain-core wires the surface
 * package to its own services. The inbound webhook deployable (Slack
 * interactivity, the email approval route, the Teams messaging endpoint)
 * constructs this once at boot and routes verified decisions into
 * `approvals.handle`.
 *
 * Run this as its own least-privilege process, separate from the core protocol
 * service. Same repo, separate deploy: the monorepo does not force a shared
 * runtime, and the surface tokens (Slack, Teams, ESP) should never sit in the
 * core protocol process.
 *
 * Transport clients are injected, not constructed here, so this stays free of
 * @slack/web-api, botbuilder, and ESP wiring. The deployable builds them from
 * config and passes them in. See CODEX_PROMPT.md task 2.
 */
export interface SurfaceClients {
  slack?: SlackClient | undefined;
  teams?: TeamsClient | undefined;
  email?: EmailClient | undefined;
}

export interface SurfaceRuntime {
  surfaces: SurfaceRegistry;
  dispatcher: Dispatcher;
  approvals: ApprovalService;
}

export function buildSurfaceRuntime(input: {
  services: CoreServices;
  config: SurfaceConfig;
  clients: SurfaceClients;
}): SurfaceRuntime {
  const { services, config, clients } = input;

  const surfaces = new SurfaceRegistry();

  if (config.slack.enabled) {
    if (!clients.slack) throw new Error("Slack enabled but no SlackClient provided");
    surfaces.register(new SlackAdapter(clients.slack));
  }
  if (config.teams.enabled) {
    if (!clients.teams) throw new Error("Teams enabled but no TeamsClient provided");
    surfaces.register(new TeamsAdapter(clients.teams));
  }
  if (config.email.enabled) {
    if (!clients.email) throw new Error("Email enabled but no EmailClient provided");
    surfaces.register(
      new EmailAdapter(clients.email, {
        approvalBaseUrl: config.email.approvalBaseUrl,
        tokenSecret: config.email.tokenSecret,
      }),
    );
  }

  const ports = buildBrainCorePorts(services);
  const dispatcher = new Dispatcher(surfaces, {
    async onDelivered({ proposal, result }) {
      if (result.ref === undefined) return;
      await services.proposals.saveDeliveredRef({
        tenantId: proposal.tenantId,
        proposalId: proposal.id,
        surface: result.surface,
        target: result.target,
        ref: result.ref,
      });
    },
  });
  const approvals = new ApprovalService(ports, surfaces, (q) => services.proposals.load(q));

  return { surfaces, dispatcher, approvals };
}
