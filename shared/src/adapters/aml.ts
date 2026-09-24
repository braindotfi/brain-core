import { createHmac } from "node:crypto";
import {
  bearerHeaders,
  fetchJson,
  providerSetup,
  withProviderFallback,
  type ProviderAdapterOptions,
  type ProviderSetupState,
} from "./provider-support.js";

export type ScreeningStatus = "clear" | "possible_match" | "match" | "unknown";

export interface ScreeningSubject {
  readonly tenant_id: string;
  readonly beneficiary_id: string;
  readonly beneficiary_name?: string | null;
  readonly jurisdictions_involved?: readonly string[];
}

export interface OfacScreeningResult {
  readonly status: ScreeningStatus;
  readonly lists_checked: readonly string[];
  readonly timestamp: string;
}

export interface PepScreeningResult {
  readonly status: ScreeningStatus;
  readonly matches: readonly Record<string, unknown>[];
}

export interface KycFreshnessResult {
  readonly last_refreshed?: string;
  readonly expires?: string;
  readonly status: "fresh" | "stale" | "unknown";
  readonly note?: string;
}

export interface OfacScreener {
  screen(subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult>;
}

export interface PepScreener {
  screen(subject: ScreeningSubject, now: Date): Promise<PepScreeningResult>;
}

export interface KycStore {
  getFreshness(
    tenantId: string,
    beneficiaryId: string,
    now: Date,
  ): Promise<KycFreshnessResult | null>;
}

export class InMemoryOfacScreener implements OfacScreener {
  async screen(_subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult> {
    return {
      status: "clear",
      lists_checked: ["stub.ofac"],
      timestamp: now.toISOString(),
    };
  }
}

export class InMemoryPepScreener implements PepScreener {
  async screen(_subject: ScreeningSubject, _now: Date): Promise<PepScreeningResult> {
    return { status: "clear", matches: [] };
  }
}

export class UnwiredKycStore implements KycStore {
  async getFreshness(
    _tenantId: string,
    _beneficiaryId: string,
    _now: Date,
  ): Promise<KycFreshnessResult> {
    return { status: "stale", note: "kyc_store_not_wired" };
  }
}

export interface ComplyAdvantageScreenerOptions extends ProviderAdapterOptions {
  readonly apiKey: string;
  readonly endpoint: string;
}

export class ComplyAdvantageScreener {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("comply_advantage", env, [
      "COMPLY_ADVANTAGE_API_KEY",
      "COMPLY_ADVANTAGE_ENDPOINT",
    ]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallbackOfac = new OpenSanctionsOfacScreener();
  private readonly fallbackPep = new OpenSanctionsPepScreener();
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  public constructor(private readonly opts: ComplyAdvantageScreenerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async screenOfac(subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult> {
    const cached = this.getCached<OfacScreeningResult>("ofac", subject, now);
    if (cached !== undefined) return cached;
    return withProviderFallback(
      {
        adapterKind: "ofac",
        provider: "comply_advantage",
        operation: "screen",
        tenantId: subject.tenant_id,
      },
      this.opts,
      async () => {
        const result = await this.screenProvider(subject, now, "sanction");
        const value = {
          status: result.status,
          lists_checked: result.lists_checked,
          timestamp: now.toISOString(),
        };
        this.setCached("ofac", subject, now, value);
        return value;
      },
      () => this.fallbackOfac.screen(subject, now),
    );
  }

  public async screenPep(subject: ScreeningSubject, now: Date): Promise<PepScreeningResult> {
    const cached = this.getCached<PepScreeningResult>("pep", subject, now);
    if (cached !== undefined) return cached;
    return withProviderFallback<{
      status: ScreeningStatus;
      matches: readonly Record<string, unknown>[];
    }>(
      {
        adapterKind: "pep",
        provider: "comply_advantage",
        operation: "screen",
        tenantId: subject.tenant_id,
      },
      this.opts,
      async () => {
        const result = await this.screenProvider(subject, now, "pep");
        const value = { status: result.status, matches: result.matches };
        this.setCached("pep", subject, now, value);
        return value;
      },
      () => this.fallbackPep.screen(subject, now),
    );
  }

  private async screenProvider(
    subject: ScreeningSubject,
    _now: Date,
    searchType: "all" | "sanction" | "pep",
  ): Promise<{
    status: ScreeningStatus;
    lists_checked: readonly string[];
    matches: readonly Record<string, unknown>[];
  }> {
    const payload = {
      search_term: subject.beneficiary_name ?? subject.beneficiary_id,
      fuzziness: 0.6,
      filters: { types: searchType === "all" ? [] : [searchType] },
      share_url: 0,
    };
    const raw = await fetchJson(
      this.fetchImpl,
      `${this.opts.endpoint.replace(/\/+$/, "")}/searches`,
      {
        method: "POST",
        headers: bearerHeaders(this.opts.apiKey),
        body: JSON.stringify(payload),
      },
    );
    const data = raw as { content?: { data?: { hits?: unknown[] } } };
    const hits = data.content?.data?.hits ?? [];
    return {
      status: hits.length === 0 ? "clear" : "possible_match",
      lists_checked: [`comply_advantage.${searchType}`],
      matches: hits.filter(
        (hit): hit is Record<string, unknown> => typeof hit === "object" && hit !== null,
      ),
    };
  }

  private getCached<T>(kind: string, subject: ScreeningSubject, now: Date): T | undefined {
    const entry = this.cache.get(cacheKey(kind, subject));
    if (entry === undefined || entry.expiresAt <= now.getTime()) return undefined;
    return entry.value as T;
  }

  private setCached(kind: string, subject: ScreeningSubject, now: Date, value: unknown): void {
    this.cache.set(cacheKey(kind, subject), {
      expiresAt: now.getTime() + 24 * 3600 * 1000,
      value,
    });
  }
}

export class ComplyAdvantageOfacScreener implements OfacScreener {
  private readonly client: ComplyAdvantageScreener;

  public constructor(opts: ComplyAdvantageScreenerOptions) {
    this.client = new ComplyAdvantageScreener(opts);
  }

  public screen(subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult> {
    return this.client.screenOfac(subject, now);
  }
}

export class ComplyAdvantagePepScreener implements PepScreener {
  private readonly client: ComplyAdvantageScreener;

  public constructor(opts: ComplyAdvantageScreenerOptions) {
    this.client = new ComplyAdvantageScreener(opts);
  }

  public screen(subject: ScreeningSubject, now: Date): Promise<PepScreeningResult> {
    return this.client.screenPep(subject, now);
  }
}

class OpenSanctionsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  public constructor(private readonly opts: ProviderAdapterOptions & { endpoint?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async screenOfac(subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult> {
    const cached = this.getCached<OfacScreeningResult>("ofac", subject, now);
    if (cached !== undefined) return cached;
    const result = await this.query(subject, "sanctions");
    const value = {
      status: result.status,
      lists_checked: ["opensanctions.sanctions"],
      timestamp: now.toISOString(),
    };
    this.setCached("ofac", subject, now, value);
    return value;
  }

  public async screenPep(subject: ScreeningSubject, _now: Date): Promise<PepScreeningResult> {
    const cached = this.getCached<PepScreeningResult>("pep", subject, _now);
    if (cached !== undefined) return cached;
    const result = await this.query(subject, "pep");
    const value = { status: result.status, matches: result.matches };
    this.setCached("pep", subject, _now, value);
    return value;
  }

  private async query(
    subject: ScreeningSubject,
    dataset: "sanctions" | "pep",
  ): Promise<{ status: ScreeningStatus; matches: readonly Record<string, unknown>[] }> {
    return withProviderFallback<{
      status: ScreeningStatus;
      matches: readonly Record<string, unknown>[];
    }>(
      {
        adapterKind: dataset === "pep" ? "pep" : "ofac",
        provider: "opensanctions",
        operation: "match",
        tenantId: subject.tenant_id,
      },
      this.opts,
      async () => {
        const endpoint = this.opts.endpoint ?? "https://api.opensanctions.org/match/default";
        const raw = await fetchJson(this.fetchImpl, endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            queries: {
              [subject.beneficiary_id]: {
                schema: "Person",
                properties: { name: [subject.beneficiary_name ?? subject.beneficiary_id] },
              },
            },
            datasets: [dataset],
          }),
        });
        const responses = raw as { responses?: Record<string, { results?: unknown[] }> };
        const results = responses.responses?.[subject.beneficiary_id]?.results ?? [];
        const matches = results.filter(
          (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
        );
        return { status: matches.length === 0 ? "clear" : "possible_match", matches };
      },
      async () => ({ status: "unknown", matches: [] }),
    );
  }

  private getCached<T>(kind: string, subject: ScreeningSubject, now: Date): T | undefined {
    const entry = this.cache.get(cacheKey(kind, subject));
    if (entry === undefined || entry.expiresAt <= now.getTime()) return undefined;
    return entry.value as T;
  }

  private setCached(kind: string, subject: ScreeningSubject, now: Date, value: unknown): void {
    this.cache.set(cacheKey(kind, subject), {
      expiresAt: now.getTime() + 24 * 3600 * 1000,
      value,
    });
  }
}

export class OpenSanctionsOfacScreener implements OfacScreener {
  private readonly client: OpenSanctionsClient;

  public constructor(opts: ProviderAdapterOptions & { endpoint?: string } = {}) {
    this.client = new OpenSanctionsClient(opts);
  }

  public screen(subject: ScreeningSubject, now: Date): Promise<OfacScreeningResult> {
    return this.client.screenOfac(subject, now);
  }
}

export class OpenSanctionsPepScreener implements PepScreener {
  private readonly client: OpenSanctionsClient;

  public constructor(opts: ProviderAdapterOptions & { endpoint?: string } = {}) {
    this.client = new OpenSanctionsClient(opts);
  }

  public screen(subject: ScreeningSubject, now: Date): Promise<PepScreeningResult> {
    return this.client.screenPep(subject, now);
  }
}

export interface SumsubKycStoreOptions extends ProviderAdapterOptions {
  readonly appToken: string;
  readonly secret: string;
  readonly endpoint?: string;
}

export class SumsubKycStore implements KycStore {
  public static setupState(env: Record<string, string | undefined>): ProviderSetupState {
    return providerSetup("sumsub", env, ["SUMSUB_APP_TOKEN", "SUMSUB_SECRET"]);
  }

  private readonly fetchImpl: typeof fetch;
  private readonly fallback = new UnwiredKycStore();

  public constructor(private readonly opts: SumsubKycStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public async getFreshness(
    tenantId: string,
    beneficiaryId: string,
    now: Date,
  ): Promise<KycFreshnessResult | null> {
    return withProviderFallback(
      { adapterKind: "kyc", provider: "sumsub", operation: "getFreshness", tenantId },
      this.opts,
      async () => {
        const path = `/resources/applicants/${encodeURIComponent(beneficiaryId)}/one`;
        const raw = await fetchJson(this.fetchImpl, `${this.endpoint()}${path}`, {
          method: "GET",
          headers: this.signedHeaders(path, "GET", ""),
        });
        const packetHash = createHmac("sha256", this.opts.secret)
          .update(JSON.stringify(raw))
          .digest("hex");
        const last = applicantUpdatedAt(raw) ?? now.toISOString();
        const expires = new Date(new Date(last).getTime() + 365 * 24 * 3600 * 1000).toISOString();
        return {
          last_refreshed: last,
          expires,
          status: new Date(expires).getTime() > now.getTime() ? "fresh" : "stale",
          note: `sumsub_packet_sha256:${packetHash}`,
        };
      },
      () => this.fallback.getFreshness(tenantId, beneficiaryId, now),
    );
  }

  private endpoint(): string {
    return (this.opts.endpoint ?? "https://api.sumsub.com").replace(/\/+$/, "");
  }

  private signedHeaders(path: string, method: string, body: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", this.opts.secret)
      .update(`${ts}${method}${path}${body}`)
      .digest("hex");
    return {
      "x-app-token": this.opts.appToken,
      "x-app-access-ts": ts,
      "x-app-access-sig": signature,
      "content-type": "application/json",
    };
  }
}

function applicantUpdatedAt(raw: unknown): string | undefined {
  const obj = raw as { updatedAt?: string; createdAt?: string; review?: { reviewDate?: string } };
  return obj.review?.reviewDate ?? obj.updatedAt ?? obj.createdAt;
}

function cacheKey(kind: string, subject: ScreeningSubject): string {
  return `${kind}:${subject.tenant_id}:${subject.beneficiary_id}:${subject.beneficiary_name ?? ""}`;
}
