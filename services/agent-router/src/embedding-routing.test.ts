import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import { AgentRouter, type AgentRouterDeps } from "./router.js";
import { RulesIntentClassifier, type IntentClassifier } from "./intent-classifier.js";
import { StaticEvidenceGatherer } from "./evidence-gatherer.js";
import {
  EmbeddingIntentClassifier,
  FallbackIntentClassifier,
  reindexIntentClassifier,
} from "./embedding-classifier.js";
import { ConceptEmbeddingAdapter } from "./concept-embedder.mock.js";

function agent(
  key: string,
  category: InternalAgentDefinition["category"],
  capability: string,
  patterns: string[],
): InternalAgentDefinition {
  return {
    agent_key: key,
    display_name: key,
    provenance: "internal",
    category,
    capabilities: [capability],
    triggers: [],
    intent_patterns: patterns,
    readable_data: [],
    risk_level: "low",
    minimum_confidence: 0.5,
    required_evidence: [],
    default_authority: "propose",
    enabled_by_default: true,
  };
}

const COLLECTIONS = agent("collections", "business", "collections_followup", [
  "follow up on overdue invoice",
  "chase late payment",
]);
const TREASURY = agent("treasury", "business", "treasury_sweep", [
  "sweep idle cash",
  "move excess balance to yield",
]);
const PURCHASE_ADVISOR = agent("purchase_advisor", "consumer", "purchase_advisor", [
  "should I make this purchase",
  "is this a good time to buy",
]);
const PERSONAL_BUDGET = agent("personal_budget", "consumer", "personal_budget", [
  "track my monthly spending",
  "review my budget",
]);

const CATALOG = [COLLECTIONS, TREASURY, PURCHASE_ADVISOR, PERSONAL_BUDGET];
const ALL_CAPS = new Set(CATALOG.map((d) => d.capabilities[0]!));
const CTX: ServiceCallContext = { tenantId: "tnt_acme", actor: "user_1" };

function embeddingClassifier(): IntentClassifier {
  return new FallbackIntentClassifier(
    new EmbeddingIntentClassifier(new ConceptEmbeddingAdapter()),
    new RulesIntentClassifier(),
  );
}

function makeRouter(
  classifier: IntentClassifier,
  catalog: readonly InternalAgentDefinition[] = CATALOG,
  scoped: ReadonlySet<string> = ALL_CAPS,
): AgentRouter {
  const deps: AgentRouterDeps = {
    catalog: () => catalog,
    classifier,
    evidence: new StaticEvidenceGatherer([]),
    getScopedCapabilities: () => scoped,
    audit: new InMemoryAuditEmitter(),
  };
  return new AgentRouter(deps);
}

describe("embedding-based intent routing (flag on)", () => {
  const router = makeRouter(embeddingClassifier());

  // Each intent is a paraphrase that shares NO (or insufficient) tokens with
  // the target agent's patterns — the rules classifier alone would miss them.
  const cases: Array<{ intent: string; expected: string }> = [
    { intent: "remind clients who owe us money", expected: "collections" },
    { intent: "invest our surplus funds", expected: "treasury" },
    { intent: "should I buy a new laptop", expected: "purchase_advisor" },
    { intent: "help me manage my expenses", expected: "personal_budget" },
  ];

  for (const { intent, expected } of cases) {
    it(`routes "${intent}" → ${expected}`, async () => {
      const decision = await router.route(CTX, { tenant_id: "tnt_acme", intent });
      expect(decision.selected_agent_id).toBe(expected);
      expect(decision.policy_status).toBe("routed");
    });
  }

  it("returns no_match for an intent below the similarity threshold", async () => {
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "what is the weather today",
    });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("no_match");
  });
});

describe("rules-based intent routing (flag off) is unchanged", () => {
  it("misses a pure paraphrase the embedding classifier catches", async () => {
    const rulesRouter = makeRouter(new RulesIntentClassifier());
    const decision = await rulesRouter.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "remind clients who owe us money", // zero token overlap with patterns
    });
    expect(decision.selected_agent_id).toBeNull();
    expect(decision.policy_status).toBe("no_match");
  });

  it("still matches an intent that shares tokens with a pattern", async () => {
    const rulesRouter = makeRouter(new RulesIntentClassifier());
    const decision = await rulesRouter.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "please follow up on the overdue invoice",
    });
    expect(decision.selected_agent_id).toBe("collections");
  });
});

describe("reindex makes a newly-added agent matchable", () => {
  it("routes a travel paraphrase to a travel agent added after reindex", async () => {
    const embedder = new ConceptEmbeddingAdapter();
    const embedding = new EmbeddingIntentClassifier(embedder);
    const classifier = new FallbackIntentClassifier(embedding, new RulesIntentClassifier());

    // Index the initial catalog (no travel agent yet).
    await reindexIntentClassifier(embedding, CATALOG);

    const TRAVEL = agent("travel_finance", "consumer", "travel_finance", [
      "budget for my upcoming trip",
      "plan travel spending",
    ]);
    const extended = [...CATALOG, TRAVEL];
    const newlyIndexed = await reindexIntentClassifier(embedding, extended);
    expect(newlyIndexed).toBe(2); // only the two new travel patterns

    const router = makeRouter(classifier, extended, new Set([...ALL_CAPS, "travel_finance"]));
    const decision = await router.route(CTX, {
      tenant_id: "tnt_acme",
      intent: "planning a trip abroad next month",
    });
    expect(decision.selected_agent_id).toBe("travel_finance");
  });
});
