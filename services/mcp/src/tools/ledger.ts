/**
 * Ledger-read tools.
 *
 * Five tools wrapping the ILedgerService surface. None of them mutate;
 * they're the read-side an agent reaches for to ground its reasoning
 * in financial truth.
 */

import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// ledger.account.get
// ---------------------------------------------------------------------------

interface AccountGetInput {
  account_id: string;
}

export const accountGetTool: Tool<AccountGetInput> = {
  name: "ledger.account.get",
  description: "Fetch one account by id, including the most recent balance snapshot.",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    required: ["account_id"],
    properties: {
      account_id: { type: "string", description: "Brain account id (acct_<ulid>)" },
    },
  },
  parseInput(params): AccountGetInput {
    return { account_id: requireString(params, "account_id") };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const result = await ctx.ledger.getAccount(ctx.ctx, input.account_id);
    if (result === null) {
      return {
        payload: { found: false, account_id: input.account_id },
        summary: `Account ${input.account_id} not found.`,
      };
    }
    const a = result.account;
    const bal = result.latest_balance;
    return {
      payload: result,
      summary:
        `**${a.name}** (${a.account_type})\n` +
        `Currency: ${a.currency} · Status: ${a.status}\n` +
        `Current: ${a.current_balance ?? "unknown"} · Available: ${a.available_balance ?? "unknown"}` +
        (bal !== null ? `\nLast snapshot: ${bal.as_of}` : ""),
    };
  },
};

// ---------------------------------------------------------------------------
// ledger.accounts.list
// ---------------------------------------------------------------------------

interface AccountsListInput {
  status?: string;
  account_type?: string;
  limit?: number;
}

export const accountsListTool: Tool<AccountsListInput> = {
  name: "ledger.accounts.list",
  description:
    "List the tenant's accounts. Filter by status (active|closed|frozen|pending) or account_type.",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "closed", "frozen", "pending"] },
      account_type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  parseInput(params): AccountsListInput {
    const out: AccountsListInput = {};
    const status = optionalString(params, "status");
    const accountType = optionalString(params, "account_type");
    const limit = optionalNumber(params, "limit");
    if (status !== undefined) out.status = status;
    if (accountType !== undefined) out.account_type = accountType;
    if (limit !== undefined) out.limit = limit;
    return out;
  },
  async handle(ctx, input): Promise<ToolResult> {
    const list = await ctx.ledger.listAccounts(ctx.ctx, {
      ...(input.status !== undefined ? { status: input.status as never } : {}),
      ...(input.account_type !== undefined ? { account_type: input.account_type as never } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const lines = list.items.map(
      (a) =>
        `- ${a.name} (\`${a.id}\`, ${a.account_type}) — ${a.current_balance ?? "?"} ${a.currency} · ${a.status}`,
    );
    return {
      payload: list,
      summary:
        list.items.length === 0
          ? "No accounts match."
          : `${list.items.length} account(s):\n${lines.join("\n")}`,
    };
  },
};

// ---------------------------------------------------------------------------
// ledger.transactions.list
// ---------------------------------------------------------------------------

interface TransactionsListInput {
  account_id?: string;
  counterparty_id?: string;
  direction?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export const transactionsListTool: Tool<TransactionsListInput> = {
  name: "ledger.transactions.list",
  description:
    "Query transactions. All filters are optional; results are sorted newest-first and capped at 1000.",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    properties: {
      account_id: { type: "string" },
      counterparty_id: { type: "string" },
      direction: { type: "string", enum: ["inflow", "outflow", "transfer", "adjustment"] },
      status: {
        type: "string",
        enum: ["pending", "posted", "cleared", "failed", "reversed", "disputed"],
      },
      since: { type: "string", format: "date-time" },
      until: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
  },
  parseInput(params): TransactionsListInput {
    const out: TransactionsListInput = {};
    for (const k of [
      "account_id",
      "counterparty_id",
      "direction",
      "status",
      "since",
      "until",
    ] as const) {
      const v = optionalString(params, k);
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    const limit = optionalNumber(params, "limit");
    if (limit !== undefined) out.limit = limit;
    return out;
  },
  async handle(ctx, input): Promise<ToolResult> {
    const list = await ctx.ledger.listTransactions(ctx.ctx, {
      ...(input.account_id !== undefined ? { account_id: input.account_id } : {}),
      ...(input.counterparty_id !== undefined ? { counterparty_id: input.counterparty_id } : {}),
      ...(input.direction !== undefined ? { direction: input.direction as never } : {}),
      ...(input.status !== undefined ? { status: input.status as never } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const lines = list.items
      .slice(0, 25)
      .map(
        (t) =>
          `- ${t.transaction_date.slice(0, 10)} · ${t.direction} ${t.amount} ${t.currency}` +
          (t.counterparty_id !== null ? ` cp=${t.counterparty_id}` : "") +
          (t.description_normalized !== null ? ` "${t.description_normalized}"` : ""),
      );
    return {
      payload: list,
      summary:
        list.items.length === 0
          ? "No transactions match."
          : `${list.items.length} transaction(s) (showing first 25):\n${lines.join("\n")}`,
    };
  },
};

// ---------------------------------------------------------------------------
// ledger.obligations.list
// ---------------------------------------------------------------------------

interface ObligationsListInput {
  status?: string;
  type?: string;
  due_before?: string;
  limit?: number;
}

export const obligationsListTool: Tool<ObligationsListInput> = {
  name: "ledger.obligations.list",
  description:
    "List obligations (bills, invoices, subscriptions, rent, payroll, taxes, card statements).",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["upcoming", "due", "paid", "overdue", "cancelled", "disputed"],
      },
      type: { type: "string" },
      due_before: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  parseInput(params): ObligationsListInput {
    const out: ObligationsListInput = {};
    for (const k of ["status", "type", "due_before"] as const) {
      const v = optionalString(params, k);
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    const limit = optionalNumber(params, "limit");
    if (limit !== undefined) out.limit = limit;
    return out;
  },
  async handle(ctx, input): Promise<ToolResult> {
    const list = await ctx.ledger.listObligations(ctx.ctx, {
      ...(input.status !== undefined ? { status: input.status as never } : {}),
      ...(input.type !== undefined ? { type: input.type as never } : {}),
      ...(input.due_before !== undefined ? { due_before: input.due_before } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const lines = list.items.map(
      (o) =>
        `- ${o.due_date.slice(0, 10)} · ${o.type} (${o.status}) — ${o.amount_due} ${o.currency} → \`${o.id}\``,
    );
    return {
      payload: list,
      summary:
        list.items.length === 0
          ? "No obligations match."
          : `${list.items.length} obligation(s):\n${lines.join("\n")}`,
    };
  },
};

// ---------------------------------------------------------------------------
// ledger.counterparties.list
// ---------------------------------------------------------------------------

interface CounterpartiesListInput {
  q?: string;
  type?: string;
  limit?: number;
}

export const counterpartiesListTool: Tool<CounterpartiesListInput> = {
  name: "ledger.counterparties.list",
  description:
    "Search counterparties by name (q) or type. Returns id + name + risk + verified status.",
  requiredScopes: ["ledger:read"],
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string" },
      type: {
        type: "string",
        enum: [
          "merchant",
          "vendor",
          "customer",
          "employer",
          "bank",
          "wallet",
          "exchange",
          "tax_authority",
          "other",
        ],
      },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  parseInput(params): CounterpartiesListInput {
    const out: CounterpartiesListInput = {};
    const q = optionalString(params, "q");
    const type = optionalString(params, "type");
    const limit = optionalNumber(params, "limit");
    if (q !== undefined) out.q = q;
    if (type !== undefined) out.type = type;
    if (limit !== undefined) out.limit = limit;
    return out;
  },
  async handle(ctx, input): Promise<ToolResult> {
    const list = await ctx.ledger.listCounterparties(ctx.ctx, {
      ...(input.q !== undefined ? { q: input.q } : {}),
      ...(input.type !== undefined ? { type: input.type as never } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const lines = list.items.map(
      (cp) =>
        `- ${cp.name} (\`${cp.id}\`, ${cp.type})` +
        (cp.risk_level !== null ? ` · risk=${cp.risk_level}` : "") +
        (cp.verified_status !== null ? ` · verified=${cp.verified_status}` : ""),
    );
    return {
      payload: list,
      summary:
        list.items.length === 0
          ? "No counterparties match."
          : `${list.items.length} counterparty (counterparties):\n${lines.join("\n")}`,
    };
  },
};

export const ledgerTools: Tool[] = [
  accountGetTool as unknown as Tool,
  accountsListTool as unknown as Tool,
  transactionsListTool as unknown as Tool,
  obligationsListTool as unknown as Tool,
  counterpartiesListTool as unknown as Tool,
];
