/**
 * validatePolicyDocument (H-P0-1): one test per structural rejection, plus
 * positive cases proving the documents live tenants actually run still
 * validate.
 */

import { describe, expect, it } from "vitest";
import { validatePolicyDocument } from "./validate.js";

interface CapturedError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function captureError(fn: () => unknown): CapturedError {
  try {
    fn();
  } catch (err) {
    return err as CapturedError;
  }
  throw new Error("expected validatePolicyDocument to throw");
}

function expectInvalid(raw: unknown, messageSubstring: string): void {
  const err = captureError(() => validatePolicyDocument(raw));
  expect(err.code).toBe("policy_rule_invalid");
  expect(err.message).toContain(messageSubstring);
}

function baseRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    applies_to: ["outbound_payment"],
    when: {},
    execute: "reject",
    ...overrides,
  };
}

function baseDoc(rules: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, rules, ...extra };
}

describe("validatePolicyDocument -- top-level shape", () => {
  it("rejects null", () => {
    expectInvalid(null, "must be a non-null object");
  });
  it("rejects a non-object", () => {
    expectInvalid("not an object", "must be a non-null object");
  });
  it("rejects an array", () => {
    expectInvalid([], "must be a non-null object");
  });
  it("rejects a non-integer version", () => {
    expectInvalid(baseDoc([baseRule()], { version: 1.5 }), "version must be an integer >= 1");
  });
  it("rejects version 0", () => {
    expectInvalid(baseDoc([baseRule()], { version: 0 }), "version must be an integer >= 1");
  });
  it("rejects a missing rules array", () => {
    expectInvalid({ version: 1 }, "rules must be a non-empty array");
  });
  it("rejects an empty rules array", () => {
    expectInvalid(baseDoc([]), "rules must be a non-empty array");
  });
  it("accepts a minimal single-rule document", () => {
    expect(() => validatePolicyDocument(baseDoc([baseRule()]))).not.toThrow();
  });
});

describe("validatePolicyDocument -- rule shape", () => {
  it("rejects a rule that is not an object", () => {
    expectInvalid(baseDoc(["not-a-rule"]), "rules[0] must be an object");
  });
  it("rejects a missing rule id", () => {
    const rule = baseRule();
    delete rule.id;
    expectInvalid(baseDoc([rule]), "rules[0].id must be a non-empty string");
  });
  it("rejects an empty rule id", () => {
    expectInvalid(baseDoc([baseRule({ id: "" })]), "rules[0].id must be a non-empty string");
  });
  it("rejects a duplicate rule id", () => {
    expectInvalid(
      baseDoc([baseRule({ id: "dup" }), baseRule({ id: "dup" })]),
      'duplicate rule id "dup"',
    );
  });
  it("rejects a missing applies_to", () => {
    const rule = baseRule();
    delete rule.applies_to;
    expectInvalid(baseDoc([rule]), "rules[0].applies_to must be a non-empty array");
  });
  it("rejects an empty applies_to array", () => {
    expectInvalid(baseDoc([baseRule({ applies_to: [] })]), "must be a non-empty array");
  });
  it("rejects an unknown applies_to value", () => {
    expectInvalid(baseDoc([baseRule({ applies_to: ["bogus"] })]), "unknown value");
  });
  it("rejects a missing when", () => {
    const rule = baseRule();
    delete rule.when;
    expectInvalid(baseDoc([rule]), "rules[0].when must be a non-null object");
  });
  it("rejects a when with an unknown key (the highest-cost typo class)", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "amount.lte ": { currency: "USD", value: "10" } } })]),
      "unknown key",
    );
  });
  it("rejects an unsupported execute value", () => {
    expectInvalid(
      baseDoc([baseRule({ execute: "maybe" })]),
      "must be one of auto, confirm, reject",
    );
  });
});

describe("validatePolicyDocument -- amount literals", () => {
  const AMOUNT_FIELDS = [
    "approval_required_above",
    "x402_autonomous_max_amount",
    "ach_autonomous_max_amount",
    "card_autonomous_max_amount",
  ] as const;

  it("rejects when.amount.lte with a numeric value instead of a string", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "amount.lte": { currency: "USD", value: 10 } } })]),
      "value must be a string decimal, not a number",
    );
  });
  it("rejects when.amount.gt with a missing currency", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "amount.gt": { value: "10" } } })]),
      "currency must be a non-empty string",
    );
  });
  it("rejects a value with more than 18 fractional digits", () => {
    expectInvalid(
      baseDoc([
        baseRule({ when: { "amount.lte": { currency: "USD", value: "1.0000000000000000001" } } }),
      ]),
      "at most 18 fractional digits",
    );
  });
  for (const field of AMOUNT_FIELDS) {
    it(`rejects a malformed ${field}`, () => {
      expectInvalid(
        baseDoc([baseRule({ [field]: { currency: "USD", value: "not-a-number" } })]),
        field,
      );
    });
  }
  it("rejects agent.spend_in_window.lte with a numeric value", () => {
    expectInvalid(
      baseDoc([
        baseRule({
          when: { "agent.spend_in_window": { window: "24h", lte: { currency: "USD", value: 5 } } },
        }),
      ]),
      "value must be a string decimal",
    );
  });
});

describe("validatePolicyDocument -- unit-interval and enum whens", () => {
  it("rejects agent.confidence.gte above 1", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.confidence.gte": 1.1 } })]),
      "inclusive range 0 to 1",
    );
  });
  it("rejects agent.evidence_score.gte below 0", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.evidence_score.gte": -0.1 } })]),
      "inclusive range 0 to 1",
    );
  });
  it("rejects an unknown agent.risk_level.lte", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.risk_level.lte": "extreme" } })]),
      "must be one of low, medium, high, critical",
    );
  });
  it("rejects an unknown tenant.category", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "tenant.category": "nonprofit" } })]),
      'must be "business" or "consumer"',
    );
  });
});

describe("validatePolicyDocument -- window constraints", () => {
  it("rejects agent.tx_count_in_window with a non-integer lte", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.tx_count_in_window": { window: "24h", lte: 1.5 } } })]),
      "lte must be an integer >= 0",
    );
  });
  it("rejects agent.tx_count_in_window with a negative lte", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.tx_count_in_window": { window: "24h", lte: -1 } } })]),
      "lte must be an integer >= 0",
    );
  });
  it("rejects an unsupported window string on agent.spend_in_window (silently becomes an all-time bucket otherwise)", () => {
    expectInvalid(
      baseDoc([
        baseRule({
          when: {
            "agent.spend_in_window": {
              window: "12h",
              lte: { currency: "USD", value: "100" },
            },
          },
        }),
      ]),
      "must be one of 1h, 24h, 7d, 30d",
    );
  });
});

describe("validatePolicyDocument -- counterparty list references", () => {
  it("rejects counterparty.in referencing a list that is not defined (the highest-value check here)", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "counterparty.in": "vendors.trusted" } })]),
      'references list "vendors.trusted" which is not defined',
    );
  });
  it("accepts counterparty.not_in when the list is defined", () => {
    expect(() =>
      validatePolicyDocument(
        baseDoc([baseRule({ when: { "counterparty.not_in": "vendors.blocked" } })], {
          lists: { "vendors.blocked": ["cp_1"] },
        }),
      ),
    ).not.toThrow();
  });
});

describe("validatePolicyDocument -- action.in / action.not_in / agent.behaviorHash / agent.id / agent.role", () => {
  it("rejects action.in with a non-string-array", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "action.in": ["ok", 5] } })]),
      "must be an array of non-empty strings",
    );
  });
  it("rejects action.not_in with an empty-string entry", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "action.not_in": [""] } })]),
      "must be an array of non-empty strings",
    );
  });
  it("rejects agent.behaviorHash without a 0x prefix", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.behaviorHash": "deadbeef" } })]),
      "must be a 0x-prefixed hex string",
    );
  });
  it("rejects an empty agent.id", () => {
    expectInvalid(baseDoc([baseRule({ when: { "agent.id": "" } })]), "must be a non-empty string");
  });
  it("rejects an empty agent.role", () => {
    expectInvalid(
      baseDoc([baseRule({ when: { "agent.role": "" } })]),
      "must be a non-empty string",
    );
  });
});

describe("validatePolicyDocument -- require", () => {
  it("rejects an empty require string", () => {
    expectInvalid(
      baseDoc([baseRule({ require: "" })]),
      "rules[0].require must be a non-empty string",
    );
  });
  it("accepts single_signer, <role>_approval, and <role>_and_<role>", () => {
    expect(() =>
      validatePolicyDocument(baseDoc([baseRule({ id: "a", require: "single_signer" })])),
    ).not.toThrow();
    expect(() =>
      validatePolicyDocument(baseDoc([baseRule({ id: "b", require: "finance_approval" })])),
    ).not.toThrow();
    expect(() =>
      validatePolicyDocument(baseDoc([baseRule({ id: "c", require: "finance_and_owner" })])),
    ).not.toThrow();
  });
});

describe("validatePolicyDocument -- lists, agent_actions, message_templates", () => {
  it("rejects a lists entry that is not a string array", () => {
    expectInvalid(
      baseDoc([baseRule()], { lists: { "vendors.trusted": ["ok", 5] } }),
      "lists.vendors.trusted must be an array of strings",
    );
  });
  it("rejects an agent_actions entry with an empty string", () => {
    expectInvalid(
      baseDoc([baseRule()], { agent_actions: { payment: [""] } }),
      "agent_actions.payment must be an array of non-empty strings",
    );
  });
  it("rejects a message_templates entry missing a subject", () => {
    expectInvalid(
      baseDoc([baseRule()], {
        message_templates: [{ id: "t1", body: "hi", allowed_variables: [] }],
      }),
      "message_templates[0].subject must be a non-empty string",
    );
  });
  it("rejects a placeholder not present in allowed_variables (would ship literal braces to a counterparty)", () => {
    expectInvalid(
      baseDoc([baseRule()], {
        message_templates: [
          {
            id: "t1",
            subject: "Hi {{name}}",
            body: "Amount due: {{amount}}",
            allowed_variables: ["name"],
          },
        ],
      }),
      "references placeholder {{amount}} which is not in allowed_variables",
    );
  });
  it("accepts a message_template whose placeholders are all allowed", () => {
    expect(() =>
      validatePolicyDocument(
        baseDoc([baseRule()], {
          message_templates: [
            {
              id: "t1",
              subject: "Hi {{name}}",
              body: "Amount due: {{amount}}",
              allowed_variables: ["name", "amount"],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("validatePolicyDocument -- real documents live tenants run", () => {
  it("accepts the provisioned default policy document (services/api/src/onboarding/provision.ts buildDefaultPolicyDocument)", () => {
    // Read directly from provision.ts rather than retyped from memory (kept
    // as a literal here since @brain/policy does not depend on @brain/api).
    const doc = {
      version: 1,
      rules: [
        {
          id: "default-money-requires-confirmation",
          applies_to: ["outbound_payment", "onchain_tx"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-non-money-confidence-floor",
          applies_to: ["inbound_payment", "ledger_write"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "auto",
        },
      ],
    };
    expect(() => validatePolicyDocument(doc)).not.toThrow();
  });

  it("accepts the three-rule document services/policy/migrations/0006_default_policy_agent_action_review.sql activates for already-upgraded tenants", () => {
    // This is the same document as above (migration 0006's new_content is
    // identical to buildDefaultPolicyDocument's current shape); asserted
    // separately per the task because that migration is what live upgraded
    // tenants are actually running today.
    const doc = {
      version: 1,
      rules: [
        {
          id: "default-money-requires-confirmation",
          applies_to: ["outbound_payment", "onchain_tx"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-non-money-confidence-floor",
          applies_to: ["inbound_payment", "ledger_write"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "auto",
        },
      ],
    };
    expect(() => validatePolicyDocument(doc)).not.toThrow();
  });
});
