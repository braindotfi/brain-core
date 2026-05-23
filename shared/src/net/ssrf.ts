/**
 * SSRF guard. Brain fetches two classes of operator-influenced URLs:
 *   - raw ingest by URL (POST /raw/ingest with a `url`)
 *   - outbound webhook delivery to tenant-registered endpoints
 *
 * Either is an SSRF vector: a caller could point Brain at the cloud metadata
 * endpoint (169.254.169.254), loopback, or an internal service. `isPublicUrl`
 * rejects non-http(s) schemes, embedded credentials, and any host that resolves
 * to a private / loopback / link-local / reserved address.
 *
 * Residual risk: DNS rebinding (the host could resolve to a public address here
 * and a private one at fetch time). Fully closing that requires pinning the
 * socket to the validated IP; tracked as a follow-up. This guard closes the
 * common cases (literal internal IPs and internal hostnames).
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface PublicUrlOptions {
  /** Allowed URL protocols, including the trailing colon. Default: ["https:"]. */
  allowedProtocols?: ReadonlyArray<string>;
}

function buildBlockList(): BlockList {
  const bl = new BlockList();
  // IPv4 — RFC 1918 + loopback + link-local + CGNAT + unspecified + reserved/multicast.
  bl.addSubnet("0.0.0.0", 8, "ipv4");
  bl.addSubnet("10.0.0.0", 8, "ipv4");
  bl.addSubnet("100.64.0.0", 10, "ipv4");
  bl.addSubnet("127.0.0.0", 8, "ipv4");
  bl.addSubnet("169.254.0.0", 16, "ipv4");
  bl.addSubnet("172.16.0.0", 12, "ipv4");
  bl.addSubnet("192.0.0.0", 24, "ipv4");
  bl.addSubnet("192.168.0.0", 16, "ipv4");
  bl.addSubnet("198.18.0.0", 15, "ipv4");
  bl.addSubnet("224.0.0.0", 4, "ipv4");
  bl.addSubnet("240.0.0.0", 4, "ipv4");
  // IPv6 — unspecified, loopback, ULA, link-local, multicast.
  bl.addAddress("::", "ipv6");
  bl.addAddress("::1", "ipv6");
  bl.addSubnet("fc00::", 7, "ipv6");
  bl.addSubnet("fe80::", 10, "ipv6");
  bl.addSubnet("ff00::", 8, "ipv6");
  return bl;
}

const BLOCKED = buildBlockList();

function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return BLOCKED.check(addr, "ipv4");
  if (family === 6) {
    if (BLOCKED.check(addr, "ipv6")) return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — check the embedded IPv4.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr);
    if (mapped !== null && mapped[1] !== undefined && isIP(mapped[1]) === 4) {
      return BLOCKED.check(mapped[1], "ipv4");
    }
    return false;
  }
  return true; // not a valid IP — block defensively
}

/**
 * Resolves true iff `rawUrl` is safe to fetch: an allowed scheme, no embedded
 * credentials, and a host that resolves only to public addresses. Never throws.
 */
export async function isPublicUrl(rawUrl: string, opts: PublicUrlOptions = {}): Promise<boolean> {
  const allowed = opts.allowedProtocols ?? ["https:"];

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!allowed.includes(url.protocol)) return false;
  if (url.username !== "" || url.password !== "") return false;

  const host = url.hostname;
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      if (resolved.length === 0) return false;
      addresses = resolved.map((r) => r.address);
    } catch {
      return false;
    }
  }

  return addresses.every((addr) => !isBlockedAddress(addr));
}
