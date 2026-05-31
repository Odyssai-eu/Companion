/**
 * OAuth 2.1 + PKCE client for MCP servers.
 *
 * Implements the discovery + Dynamic Client Registration + authorization
 * code + refresh flows defined by the MCP authorization spec, which is
 * a profile of OAuth 2.1 (RFC 6749/9126/7636/7591).
 *
 * Flow (caller in routes/mcp-servers.ts):
 *
 *   POST /api/mcp-servers/:id/oauth/start
 *     1. discoverMetadata(url) → fetches /.well-known/oauth-authorization-server
 *     2. registerClient(metadata) → POSTs to registration_endpoint, gets
 *        client_id (+ optional client_secret)
 *     3. generatePkce() → code_verifier + code_challenge (S256)
 *     4. persist pending row (state, verifier, redirect_uri)
 *     5. return authorizationUrl for the UI to redirect to
 *
 *   GET /api/mcp-servers/oauth/callback?code=…&state=…
 *     1. lookup pending row by state, verify ownership + age
 *     2. exchangeCode(metadata, clientCreds, code, verifier, redirectUri)
 *     3. persist access_token + refresh_token + expires_at on mcp_servers
 *     4. delete pending row
 *     5. close popup / redirect UI
 *
 *   refreshAccessToken(server) — called when access_token is expired or
 *     after a 401 from the MCP server.
 *
 *   ensureFreshAccessToken(server) — convenience: returns a valid token,
 *     refreshing in-place if needed. Used by mcp-client.ts before every
 *     call when authKind === 'oauth'.
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { mcpServers, type McpServerRow } from "../db/schema";
import { assertFetchTargetAllowed } from "./net-guard";

export type AuthServerMetadata = {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  response_types_supported?: string[];
};

const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 8_000;

/**
 * Fetch the OAuth authorization-server metadata for an MCP server URL.
 *
 * RFC 8414 standard path is `<issuer>/.well-known/oauth-authorization-server`.
 * MCP servers vary on whether the issuer = the MCP endpoint base or its
 * origin — we try the origin first (most common per spec) then fall back
 * to the path-stripped MCP URL.
 */
export async function discoverMetadata(
  mcpUrl: string,
): Promise<AuthServerMetadata> {
  await assertFetchTargetAllowed(mcpUrl); // SSRF guard (#3)
  const u = new URL(mcpUrl);
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server`,
    // Some servers expose the doc colocated with the MCP path
    `${u.origin}${u.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ];
  let lastErr: string | null = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (r.ok) {
        const meta = (await r.json()) as AuthServerMetadata;
        if (!meta.authorization_endpoint || !meta.token_endpoint) {
          lastErr = `discovery at ${url} returned no endpoints`;
          continue;
        }
        return meta;
      }
      lastErr = `discovery at ${url} → ${r.status}`;
    } catch (e) {
      lastErr = `discovery at ${url}: ${(e as Error).message}`;
    }
  }
  throw new Error(lastErr ?? "OAuth discovery failed");
}

/**
 * Dynamic Client Registration (RFC 7591). Asks the auth server to mint
 * us a client_id (+ optional client_secret) on the fly, so we don't
 * need an a-priori registered app per provider. Companion sends its
 * own metadata: name, redirect URIs, grants we want.
 *
 * Falls back gracefully when the server doesn't advertise a
 * registration_endpoint — Notion / GitHub / Linear all do; some older
 * OAuth servers don't, in which case the user has to register manually
 * and we'd need a future UI for "paste your client_id/secret".
 */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!metadata.registration_endpoint) {
    throw new Error(
      "auth server has no registration_endpoint; manual client_id/secret required (not implemented yet)",
    );
  }
  await assertFetchTargetAllowed(metadata.registration_endpoint); // SSRF guard (#3)
  const r = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_name: "Companion",
      redirect_uris: [redirectUri],
      // PKCE → public client (no secret). Some servers still issue a
      // confidential one; we store whatever we get.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: (metadata.scopes_supported ?? []).join(" ") || undefined,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`DCR failed: ${r.status} ${t.slice(0, 300)}`);
  }
  const body = (await r.json()) as {
    client_id?: string;
    client_secret?: string;
  };
  if (!body.client_id) {
    throw new Error("DCR returned no client_id");
  }
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret ?? null,
  };
}

/**
 * PKCE: generate a random verifier (43-128 chars URL-safe) and the
 * corresponding S256 challenge. The verifier never leaves Companion;
 * the challenge ships in the authorization URL.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

/** Build the authorization URL the user's browser is redirected to. */
export function buildAuthorizationUrl(opts: {
  metadata: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const u = new URL(opts.metadata.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  if (opts.scopes && opts.scopes.length > 0) {
    u.searchParams.set("scope", opts.scopes.join(" "));
  }
  return u.toString();
}

/** Exchange the authorization code for tokens at the token endpoint. */
export async function exchangeCode(opts: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret: string | null;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
}> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", opts.code);
  form.set("redirect_uri", opts.redirectUri);
  form.set("client_id", opts.clientId);
  form.set("code_verifier", opts.codeVerifier);
  if (opts.clientSecret) form.set("client_secret", opts.clientSecret);

  return tokenRequest(opts.metadata.token_endpoint, form);
}

/** Use a refresh_token to mint a new access_token. */
export async function refreshAccessToken(opts: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
}> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", opts.refreshToken);
  form.set("client_id", opts.clientId);
  if (opts.clientSecret) form.set("client_secret", opts.clientSecret);

  return tokenRequest(opts.metadata.token_endpoint, form);
}

async function tokenRequest(
  endpoint: string,
  form: URLSearchParams,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string | null;
}> {
  await assertFetchTargetAllowed(endpoint); // SSRF guard (#3)
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`token endpoint ${r.status}: ${t.slice(0, 300)}`);
  }
  const body = (await r.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!body.access_token) {
    throw new Error("token endpoint returned no access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresInSec: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: body.scope ?? null,
  };
}

/**
 * Return a valid access_token, refreshing in-place if the cached one
 * is close to expiry or already expired. Persists the refreshed token
 * back to the row. Throws when no refresh path is possible — the
 * caller should propagate as "re-authorization required".
 *
 * Skew of 30s so we don't accidentally use a token that expires
 * mid-request.
 */
/**
 * Force a refresh regardless of cached expiry — used by mcp-client.ts
 * when the MCP server returns 401/invalid_token. The cached
 * access_token might be revoked or rotated server-side before its
 * advertised expires_in elapses. Throws when no refresh path exists,
 * leaving it to the caller to surface "re-authorization required".
 */
export async function forceRefreshAccessToken(
  server: McpServerRow,
): Promise<string> {
  if (server.authKind !== "oauth") {
    throw new Error(`server ${server.slug} is not OAuth`);
  }
  if (!server.oauthRefreshToken) {
    throw new Error("oauth_access_expired_no_refresh");
  }
  if (!server.oauthMetadata || !server.oauthClientId) {
    throw new Error("oauth_state_corrupt");
  }
  const fresh = await refreshAccessToken({
    metadata: server.oauthMetadata as AuthServerMetadata,
    clientId: server.oauthClientId,
    clientSecret: server.oauthClientSecret,
    refreshToken: server.oauthRefreshToken,
  });
  const newExpires = fresh.expiresInSec
    ? new Date(Date.now() + fresh.expiresInSec * 1000)
    : null;
  await db
    .update(mcpServers)
    .set({
      oauthAccessToken: fresh.accessToken,
      oauthRefreshToken: fresh.refreshToken ?? server.oauthRefreshToken,
      oauthExpiresAt: newExpires,
    })
    .where(eq(mcpServers.id, server.id));
  return fresh.accessToken;
}

export async function ensureFreshAccessToken(
  server: McpServerRow,
): Promise<string> {
  if (server.authKind !== "oauth") {
    throw new Error(`server ${server.slug} is not OAuth (authKind=${server.authKind})`);
  }
  if (!server.oauthAccessToken) {
    throw new Error("oauth_not_connected");
  }
  const expiresAt = server.oauthExpiresAt
    ? new Date(server.oauthExpiresAt).getTime()
    : null;
  const stillValid = expiresAt === null || expiresAt - Date.now() > 30_000;
  if (stillValid) return server.oauthAccessToken;

  if (!server.oauthRefreshToken) {
    throw new Error("oauth_access_expired_no_refresh");
  }
  if (!server.oauthMetadata || !server.oauthClientId) {
    throw new Error("oauth_state_corrupt");
  }

  const fresh = await refreshAccessToken({
    metadata: server.oauthMetadata as AuthServerMetadata,
    clientId: server.oauthClientId,
    clientSecret: server.oauthClientSecret,
    refreshToken: server.oauthRefreshToken,
  });
  const newExpires = fresh.expiresInSec
    ? new Date(Date.now() + fresh.expiresInSec * 1000)
    : null;
  await db
    .update(mcpServers)
    .set({
      oauthAccessToken: fresh.accessToken,
      // Refresh-token rotation: use the server-returned new RT when
      // present; otherwise keep the old one (some servers don't rotate).
      oauthRefreshToken: fresh.refreshToken ?? server.oauthRefreshToken,
      oauthExpiresAt: newExpires,
    })
    .where(eq(mcpServers.id, server.id));
  return fresh.accessToken;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate a fresh opaque state value for CSRF binding. */
export function generateState(): string {
  return base64url(crypto.randomBytes(24));
}
