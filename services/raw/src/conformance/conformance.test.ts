/**
 * Connector conformance suite (Phase 6 certification).
 *
 * Runs the static contract over EVERY registered adapter, so a newly-scaffolded
 * connector is auto-certified (or fails loudly) without per-adapter boilerplate,
 * and exercises the behavioral contract against a concrete pull adapter (Merge)
 * via its provider mock.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { listAdapters, descriptorForSourceType } from "../adapters/registry.js";
import { MergeAccountingAdapter } from "../adapters/merge_accounting.js";
import type { ConnectorDescriptor } from "../adapters/descriptors.js";
import type { SourceAdapter } from "../adapters/types.js";
import { assertStaticConformance, assertFetchConformance } from "./harness.js";

describe("connector conformance — static contract (registry-wide)", () => {
  for (const adapter of listAdapters()) {
    it(`${adapter.sourceType} satisfies the static connector contract`, () => {
      const descriptor = descriptorForSourceType(adapter.sourceType);
      expect(() => assertStaticConformance(adapter, descriptor)).not.toThrow();
    });
  }
});

describe("connector conformance — behavioral contract (Merge pull adapter)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockMerge(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        const body = path.includes("/account-details")
          ? { integration: "NetSuite" }
          : {
              next: null,
              results: [
                { id: "inv_1", modified_at: "2026-06-01T00:00:00Z" },
                { id: "inv_2", modified_at: "2026-06-02T00:00:00Z" },
              ],
            };
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
        } as unknown as Response;
      }),
    );
  }

  it("emits §9-complete envelopes with retry-stable idempotency keys", async () => {
    mockMerge();
    const descriptor = descriptorForSourceType("merge_accounting");
    await expect(
      assertFetchConformance(MergeAccountingAdapter, descriptor, {
        tenantId: "tnt_conformance",
        credentials: { api_key: "merge_platform_key", account_token: "acct_token_1" },
        partition: {
          sourceId: "src_merge1",
          resourceId: "",
          objectType: "invoice",
          checkpointType: "watermark",
          committedCheckpoint: null,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails certification when an adapter's idempotency keys are not retry-stable", async () => {
    // A non-conformant adapter that keys idempotency on a per-call counter
    // (response order) instead of checkpoint position. The harness must reject
    // it: a crash-retry would re-pull with NEW keys and duplicate artifacts.
    let n = 0;
    const unstableAdapter: SourceAdapter = {
      sourceType: "other",
      fetchIncremental: async () => {
        n += 1;
        return {
          artifacts: [
            {
              body: Buffer.from("x"),
              mimeType: "application/json",
              sourceRef: {},
              envelope: { sourceSchema: "other.v1", idempotencyKey: `k_${n}` },
            },
          ],
          nextCheckpoint: null,
          hasMore: false,
        };
      },
    };
    const fakeDescriptor = { connectorType: "other" } as ConnectorDescriptor;
    await expect(
      assertFetchConformance(unstableAdapter, fakeDescriptor, {
        tenantId: "tnt_conformance",
        credentials: {},
        partition: {
          sourceId: "src_x",
          resourceId: "",
          objectType: "thing",
          checkpointType: "watermark",
          committedCheckpoint: null,
        },
      }),
    ).rejects.toThrow(/retry-stable/);
  });
});
