/**
 * Thin Brain HTTP client for E2E tests. Uses fetch against the staging
 * base URL supplied by BRAIN_BASE_URL. A tenant-scoped bearer token is
 * required (mint via your local auth service or the seed script).
 */

export interface BrainClientOptions {
  baseUrl: string;
  token: string;
}

export class BrainClient {
  public constructor(private readonly opts: BrainClientOptions) {}

  public async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  public async post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  public async postMultipart<T>(
    path: string,
    form: FormData,
  ): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}

export function envClient(): BrainClient {
  const baseUrl = process.env.BRAIN_BASE_URL;
  const token = process.env.BRAIN_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error("E2E suite requires BRAIN_BASE_URL and BRAIN_TOKEN");
  }
  return new BrainClient({ baseUrl, token });
}
