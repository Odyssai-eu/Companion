/**
 * LAN HTTP scanner for Odysseus engines.
 *
 * The brief explicitly chose HTTP scan over mDNS — mDNS from inside a
 * Docker bridge network on macOS is broken (Docker Desktop limitation),
 * and a host-side launchd watcher would defeat the zero-install promise
 * of "Join the Odyssai". So we walk the host's IPv4 interfaces, expand
 * each /24-ish subnet, and probe `/.well-known/inference-engine.json`
 * on each candidate IP with a short timeout. A response whose body has
 * `vendor: "odyssai.eu"` is a match.
 *
 * Concurrency is capped (default 64) and per-IP timeout is short
 * (1.5s) so a typical /24 finishes in ~5-10s on a healthy LAN.
 *
 * Caveat for the SaaS deploy: in dev this code runs inside the Docker
 * container on the Companion host, so it scans the Companion server's LAN — which happens to
 * be the deployment's LAN. For multi-tenant cloud users on different
 * networks, the scan won't find their local Odysseus. That's a known
 * limitation — Tauri desktop will solve it natively. Manual URL entry
 * stays available as the fallback.
 */

import os from "node:os";
import { filterToPrivateCidrs } from "../net-guard";

export type FoundEngine = {
  host: string;
  port: number;
  url: string;
  meta: {
    name?: string;
    vendor?: string;
    version?: string;
    features?: string[];
    auth?: { required?: boolean };
  };
};

const DEFAULT_PORTS = [8000];
const DEFAULT_CONCURRENCY = 64;
const DEFAULT_TIMEOUT_MS = 1500;
/** Anything wider than /20 (4094 hosts) is treated as too big to brute-scan. */
const MIN_PREFIX = 20;

function ipToInt(ip: string): number {
  return (
    ip
      .split(".")
      .reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0
  );
}

function intToIp(n: number): string {
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ].join(".");
}

function popcount(n: number): number {
  let c = 0;
  let x = n >>> 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

/**
 * Enumerate IPv4 /N subnets the host is directly attached to. Skips
 * loopback, link-local (169.254/16), and subnets wider than /20.
 */
export function getLocalSubnets(): string[] {
  const subnets = new Set<string>();
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask);
      const network = (ip & mask) >>> 0;
      const prefix = popcount(mask);
      if (prefix < MIN_PREFIX) continue;
      subnets.add(`${intToIp(network)}/${prefix}`);
    }
  }
  return Array.from(subnets);
}

function expandCidr(cidr: string): string[] {
  const [base, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  const baseInt = ipToInt(base);
  const hostCount = (1 << (32 - prefix)) - 2;
  const ips: string[] = [];
  for (let i = 1; i <= hostCount; i++) {
    ips.push(intToIp(baseInt + i));
  }
  return ips;
}

/**
 * Run `tasks` with at most `concurrency` running in parallel. Inline
 * limiter — p-limit isn't a dep here and we don't need its features.
 */
async function pmap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type ScanOptions = {
  subnetsOverride?: string[];
  timeoutPerIpMs?: number;
  concurrency?: number;
  ports?: number[];
};

export async function scanForOdysseusEngines(
  opts: ScanOptions = {},
): Promise<FoundEngine[]> {
  // In Docker bridge mode the container only sees 172.x — useless for
  // finding engines on the host's LAN. ODYSSAI_SCAN_SUBNETS lets the
  // operator inject the real subnets (comma-separated CIDRs).
  const envSubnets = (process.env.ODYSSAI_SCAN_SUBNETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s));
  const detected = getLocalSubnets();
  // Merge env-provided + host-detected, dedup. Env wins on placement
  // so admins can prepend a primary scan target.
  const merged = [...envSubnets, ...detected.filter((s) => !envSubnets.includes(s))];
  // LAN discovery only scans private ranges — a user-supplied subnetsOverride
  // can't turn this into an arbitrary external port-scanner (#3).
  const subnets = filterToPrivateCidrs(opts.subnetsOverride ?? merged);
  const ports = opts.ports ?? DEFAULT_PORTS;
  const timeoutMs = opts.timeoutPerIpMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const candidates: { ip: string; port: number }[] = [];
  for (const cidr of subnets) {
    for (const ip of expandCidr(cidr)) {
      for (const port of ports) {
        candidates.push({ ip, port });
      }
    }
  }

  const found: FoundEngine[] = [];
  await pmap(candidates, concurrency, async ({ ip, port }) => {
    const url = `http://${ip}:${port}`;
    try {
      const r = await fetch(`${url}/.well-known/inference-engine.json`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return;
      const meta = (await r.json()) as FoundEngine["meta"];
      if (meta?.vendor === "odyssai.eu") {
        found.push({ host: ip, port, url, meta });
      }
    } catch {
      // ECONNREFUSED, timeout, garbage payload — all expected most of the
      // time. The whole point of a scan is that most IPs say nothing.
    }
  });

  return found;
}
