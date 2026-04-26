/**
 * Stub page generators for the four page types Phase 5 doesn't fully
 * implement: invoice, agent, policy, cash_flow. Each returns a minimal
 * placeholder page so /memory/regenerate succeeds; the body explicitly
 * says the implementation is upcoming.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { renderPage } from "./sections.js";

abstract class StubPageGenerator implements PageGenerator {
  public abstract readonly pageType: PageGenerator["pageType"];
  protected abstract readonly slugPrefix: string;
  protected abstract readonly idPrefix: string;
  protected abstract readonly title: string;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith(this.idPrefix)) {
      return { subjectId: slugOrId, slug: `${this.slugPrefix}${slugOrId}` };
    }
    if (slugOrId.startsWith(this.slugPrefix)) {
      const id = slugOrId.slice(this.slugPrefix.length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    _deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    return {
      page_type: this.pageType,
      subject_id: subject.subjectId,
      slug: subject.slug,
      body_md: renderPage(this.title, {
        currentTruth:
          `_${this.title} pages ship in a follow-up PR after refactor-5. Subject: \`${subject.subjectId ?? subject.slug}\`._`,
      }),
      source_revision: "stub",
    };
  }
}

export class InvoicePageGenerator extends StubPageGenerator {
  public readonly pageType = "invoice" as const;
  protected readonly slugPrefix = "/invoices/";
  protected readonly idPrefix = "inv_";
  protected readonly title = "Invoice";
}

export class AgentPageGenerator extends StubPageGenerator {
  public readonly pageType = "agent" as const;
  protected readonly slugPrefix = "/agents/";
  protected readonly idPrefix = "agent_";
  protected readonly title = "Agent";
}

export class PolicyPageGenerator extends StubPageGenerator {
  public readonly pageType = "policy" as const;
  protected readonly slugPrefix = "/policies/";
  protected readonly idPrefix = "pol_";
  protected readonly title = "Policy";
}

export class CashFlowPageGenerator implements PageGenerator {
  public readonly pageType = "cash_flow" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("/cash-flow/")) {
      return { subjectId: slugOrId.slice("/cash-flow/".length), slug: slugOrId };
    }
    if (/^[a-z0-9-]+$/i.test(slugOrId)) {
      return { subjectId: slugOrId, slug: `/cash-flow/${slugOrId}` };
    }
    return null;
  }

  public async render(
    _deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    return {
      page_type: this.pageType,
      subject_id: subject.subjectId,
      slug: subject.slug,
      body_md: renderPage("Cash flow", {
        currentTruth:
          `_Cash-flow pages ship in a follow-up PR. Period: \`${subject.subjectId ?? "?"}\`._`,
      }),
      source_revision: "stub",
    };
  }
}
