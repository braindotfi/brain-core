import type { AskDeps, AskOptions, AskResult } from "@brain/wiki";
import type {
  AuditLogFilters,
  AuditLogListResult,
  ProposalReadItem,
  ProposalSnapshot,
} from "@brain/execution";
import type { AuditEmitter, ServiceCallContext, TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";

export interface RoboBriefRequest {
  tenant_id: string;
  as_of?: string;
}

export type RoboBriefSignal =
  | {
      key: "cash_on_hand";
      value_cents: number;
      currency: string;
      delta_cents_7d?: number;
      sparkline?: Array<{ date: string; value_cents: number }>;
    }
  | {
      key: "net_30_day";
      value_cents: number;
      currency: string;
      delta_pct?: number;
    }
  | {
      key: "runway_months";
      value_months?: number;
      at_burn_cents?: number;
      extends_to_months_if_forecast?: number;
    };

export interface RoboBriefHighlight {
  proposal_id: string;
  agent: string;
  title: string;
  amount_cents?: number;
  currency?: string;
  urgency: "urgent" | "attention" | "info";
}

export interface RoboBriefNextPrompt {
  label: string;
  action: {
    kind: "ask_robo" | "open_proposal";
    target_id_or_prompt: string;
  };
}

export interface RoboBriefResponse {
  tenant_id: string;
  date: string;
  prepared_at: string;
  signals: RoboBriefSignal[];
  body_markdown: string;
  highlights: RoboBriefHighlight[];
  next_prompts: RoboBriefNextPrompt[];
}

export interface RoboOvernightAction {
  agent: string;
  summary: string;
  related_proposal_ids: string[];
  occurred_at: string;
}

export interface RoboOvernightResponse {
  window: {
    start: string;
    end: string;
  };
  action_count: number;
  actions: RoboOvernightAction[];
}

export interface RoboContextSource {
  kind: "proposal_rail";
  agent: string;
  rail: string;
  proposal_id: string;
}

export interface RoboAskFromContextRequest {
  tenant_id: string;
  source: RoboContextSource;
  prompt: string;
  open_thread?: boolean;
}

export interface RoboDataCard {
  title: string;
  total?: unknown;
  rows: Array<{
    name: string;
    sub?: string;
    meta?: unknown;
    amount?: unknown;
    status?: string;
  }>;
}

export interface RoboChart {
  kind: "line" | "bar" | "forecast";
  series: Array<{
    label: string;
    points: Array<{ x: string | number; y: number }>;
  }>;
  x_axis?: unknown;
  annotations?: unknown;
}

export interface RoboAnswer {
  text: string;
  data_cards?: RoboDataCard[];
  charts?: RoboChart[];
  follow_ups?: Array<{ label: string; action: unknown }>;
  refs?: Array<{
    kind: "proposal" | "record" | "invoice" | "url";
    id: string;
    display_name: string;
  }>;
}

export interface RoboAskFromContextResponse {
  thread_id: string;
  first_response: RoboAnswer;
}

export interface RoboAnswererInput {
  deps: AskDeps;
  options: AskOptions;
}

export type RoboAnswerer = (input: RoboAnswererInput) => Promise<AskResult>;

export interface RoboServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  askWiki: RoboAnswerer;
  recordDeterministicIntentUsage: (
    client: TenantScopedClient,
    intentId: NonNullable<AskResult["deterministicIntentId"]>,
  ) => Promise<void>;
  wikiDeps: Omit<AskDeps, "client" | "requestContext" | "policyContext">;
  questionModel: string;
  getProposal?: (
    pool: Pool,
    ctx: ServiceCallContext,
    id: string,
  ) => Promise<ProposalReadItem | null>;
  listProposals?: (
    pool: Pool,
    ctx: ServiceCallContext,
    input: { status?: string; limit?: number },
  ) => Promise<{ proposals: ProposalReadItem[] }>;
  auditLog?: {
    list(ctx: ServiceCallContext, filters: AuditLogFilters): Promise<AuditLogListResult>;
  };
  insertSnapshot?: (
    client: TenantScopedClient,
    ctx: ServiceCallContext,
    payload: Record<string, unknown>,
  ) => Promise<ProposalSnapshot>;
  now?: () => Date;
  threadIdFactory?: () => string;
  messageIdFactory?: () => string;
}
