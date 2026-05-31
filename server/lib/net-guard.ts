/**
 * SSRF guards for user-driven server-side fetches (#3).
 *
 * odyssai.eu is LAN-first (see AGENTS.md "Security posture"). Reaching the
 * Odysseus engine or an MCP server on a private 10/172.16/192.168 address — or
 * loopback for a local sidecar — is the INTENDED, zero-config use, so we do NOT
 * block RFC1918 or loopback. Doing so would impose a network-security posture
 * on the operator (Bucket B), not fix exploitable code, and would break the
 * stack's primary flow.
 *
 * What we DO block is the set of targets that are never a legitimate part of
 * these features and exist purely as SSRF attack surface:
 *   - the cloud-metadata / IPv4 link-local range 169.254.0.0/16
 *     (incl. 169.254.169.254, the AWS/GCP/Azure metadata endpoint),
 *   - IPv6 link-local fe80::/10,
 *   - the unspecified / "this host" ranges (0.0.0.0/8, ::).
 *
 * This is Bucket A: network-independent code hygiene.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

/** True for addresses that are never a legitimate fetch target. */
export function isBlockedAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 link-local / cloud metadata (169.254.0.0/16)
  if (/^169\.254\./.test(v)) return true;
  // IPv4 "this host" 0.0.0.0/8
  if (/^0\./.test(v)) return true;
  // IPv6 unspecified
  if (v === "::") return true;
  // IPv6 link-local fe80::/10 (fe80–febf)
  if (/^fe[89ab][0-9a-f]:/.test(v)) return true;
  // IPv4-mapped IPv6 link-local
  if (v.startsWith("::ffff:169.254.")) return true;
  return false;
}

/**
 * Resolve `rawUrl`'s host once and reject http(s) targets that resolve to a
 * blocked address. Resolving up front (and the caller fetching the same host
 * immediately after) closes the obvious DNS-rebinding window. Throws
 * BlockedTargetError on a disallowed scheme, unresolvable host, or blocked IP.
 */
export async function assertFetchTargetAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(`invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedTargetError(`unsupported scheme: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let ip = host;
  if (!isIP(host)) {
    try {
      ip = (await lookup(host)).address;
    } catch {
      throw new BlockedTargetError(`cannot resolve host: ${host}`);
    }
  }
  if (isBlockedAddress(ip)) {
    throw new BlockedTargetError(
      `target host ${host} resolves to a blocked address (${ip})`,
    );
  }
}

/**
 * For the LAN engine-discovery scan: keep only CIDRs whose network sits in a
 * private/LAN range. A LAN sweep has no legitimate reason to probe public
 * address space, and `subnetsOverride` is user-supplied — so this stops it
 * being turned into an arbitrary external port-scanner (#3). Non-private and
 * malformed CIDRs are dropped.
 */
export function filterToPrivateCidrs(cidrs: string[]): string[] {
  return cidrs.filter((cidr) => {
    const ip = cidr.split("/")[0]?.trim() ?? "";
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    return false;
  });
}
