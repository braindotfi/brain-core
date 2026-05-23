/**
 * SSRF-safe HTTPS GET → Buffer, for operator-supplied URLs (e.g. raw ingest
 * by URL). Hardens the naive `fetch(url)` pattern against four problems:
 *
 *   1. SSRF to internal hosts — `isPublicUrl` is checked at every redirect hop.
 *   2. DNS rebinding — the socket is pinned to a validated IP via
 *      `publicOnlyLookup` (the connect-time resolution is re-validated).
 *   3. Redirect-based SSRF / credential leak — redirects are followed manually,
 *      re-validated per hop, bounded, and the Authorization header is dropped
 *      on any cross-origin hop.
 *   4. OOM — the body is streamed with a hard byte cap, never fully buffered
 *      before the limit is checked.
 */

import { request as httpsRequest } from "node:https";
import { brainError } from "../errors.js";
import { isPublicUrl, publicOnlyLookup } from "./ssrf.js";

export interface FetchPublicOptions {
  headers?: Record<string, string>;
  /** Hard cap on the response body size in bytes. */
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

export interface FetchedResource {
  body: Buffer;
  contentType: string | undefined;
}

type HopOutcome = FetchedResource | { redirectTo: string };

function getHop(
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
  timeoutMs: number,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: "GET", headers, lookup: publicOnlyLookup, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          res.resume();
          resolve({ redirectTo: new URL(location, url).toString() });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            brainError("dependency_unavailable", `fetch failed: HTTP ${status}`, {
              details: { status },
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            reject(brainError("request_too_large", "fetched artifact exceeds the size cap"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const ct = res.headers["content-type"];
          resolve({
            body: Buffer.concat(chunks),
            contentType: typeof ct === "string" ? ct : undefined,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(brainError("dependency_unavailable", "fetch timed out"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ESSRFBLOCKED") {
        reject(
          brainError("request_body_invalid", "url resolves to a non-public address", {
            cause: err,
          }),
        );
        return;
      }
      reject(brainError("dependency_unavailable", "fetch failed", { cause: err }));
    });
    req.end();
  });
}

export async function fetchPublicHttps(
  url: string,
  opts: FetchPublicOptions,
): Promise<FetchedResource> {
  const maxRedirects = opts.maxRedirects ?? 4;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let current = url;
  let headers = { ...(opts.headers ?? {}) };
  let originalOrigin: string | null = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!(await isPublicUrl(current, { allowedProtocols: ["https:"] }))) {
      throw brainError(
        "request_body_invalid",
        "url must be HTTPS and resolve to a public (non-internal) address",
      );
    }
    if (originalOrigin === null) originalOrigin = new URL(current).origin;

    const outcome = await getHop(current, headers, opts.maxBytes, timeoutMs);
    if (!("redirectTo" in outcome)) return outcome;

    // Never forward credentials to a different origin across a redirect.
    if (new URL(outcome.redirectTo).origin !== originalOrigin) {
      const { authorization: _drop, ...rest } = headers;
      headers = rest;
    }
    current = outcome.redirectTo;
  }
  throw brainError("dependency_unavailable", "too many redirects");
}
