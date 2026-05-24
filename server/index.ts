import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { runMigrations } from "./db/migrate";
import { ensureAdminExists, seedIfEmpty } from "./db/seed";
import { startMemoryScheduler } from "./lib/memory-scheduler";
import { requireUser, sessionLoader } from "./middleware/auth";
import { guestSessionLoader, requireUserOrGuest } from "./middleware/guest";
import { hermesBearerLoader } from "./middleware/hermes-token";
import addonsRoute from "./routes/addons";
// Hermes addon + hermes-bridge conversational routes retired 2026-05-19.
// The agent-token lifecycle (mint/list/revoke) moved to ./routes/agent-tokens.
import agentTokensRoute from "./routes/agent-tokens";
import mcpRoute from "./routes/mcp";
import voiceLiveAddonRoute from "./routes/addon-voice-live";
import obsidianRoute, { obsidianBearerLoader } from "./routes/addon-obsidian";
import tavilyRoute from "./routes/addon-tavily";
import routerAddonRoute from "./routes/addon-router";
import savedPromptsRoute from "./routes/saved-prompts";
import hermesAddonRoute from "./routes/addon-hermes";
import hermesAgentRoute from "./routes/agent-hermes";
import helpRoute from "./routes/help";
import { loadCorpus as loadHelpCorpus } from "./lib/help-search";
import adminGuestTokensRoute from "./routes/admin-guest-tokens";
import adminUsersRoute from "./routes/admin-users";
import authRoute from "./routes/auth";
import chatRoute from "./routes/chat";
import conversationsRoute from "./routes/conversations";
import filesRoute from "./routes/files";
import guestRoute from "./routes/guest";
import inferenceRoute from "./routes/inference";
import inferencePresetsRoute from "./routes/inference-presets";
import mcpServersRoute, { handleOauthCallback } from "./routes/mcp-servers";
import modelsRoute from "./routes/models";
import profileRoute from "./routes/profile";
import skillsRoute from "./routes/skills";
import projectMemoryRoute from "./routes/project-memory";
import projectsRoute from "./routes/projects";
import userMemoryRoute from "./routes/user-memory";
import providersRoute from "./routes/providers";
import ttsRoute from "./routes/tts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
) as { version: string };

const app = new Hono();

app.use("*", logger());

// Read the session cookie on every request so downstream code can decide
// whether to require auth. Silent on missing / invalid.
app.use("*", sessionLoader);

app.get("/api/health", (c) =>
  c.json({
    status: "ok" as const,
    version: pkg.version,
    engines: 0,
  }),
);

// Auth routes are always open (they're how you get a session)
app.route("/api/auth", authRoute);

// License gate + user gate on everything else.
// hermesBearerLoader resolves `Authorization: Bearer hms_<…>` into a real
// userId BEFORE requireUser runs, so the companion-mcp MCP server (Hermes
// Agent on .50, Cowork dispatch) can hit these routes without a cookie.
app.use("/api/conversations/*", hermesBearerLoader, requireUser);
// Chat, models, and inference accept guest tokens (Bearer / ?g= / cookie)
// in addition to regular sessions. License still applies — guests count
// against the inviting admin's license.
app.use(
  "/api/chat/*",
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use("/api/projects/*", hermesBearerLoader, requireUser);
app.use("/api/profile/*", requireUser);
app.use("/api/profile", requireUser);
app.use("/api/files/*", hermesBearerLoader, requireUser);
app.use("/api/files", hermesBearerLoader, requireUser);
app.use("/api/tts/*", requireUser);
app.use(
  "/api/inference/*",
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use("/api/providers/*", requireUser);
app.use("/api/mcp-servers/*", requireUser);
app.use("/api/mcp-servers", requireUser);
app.use("/api/skills/*", requireUser);
app.use("/api/skills", requireUser);
app.use("/api/saved-prompts/*", requireUser);
app.use("/api/saved-prompts", requireUser);
app.use("/api/agents/*", requireUser);
app.use("/api/agents", requireUser);
app.use("/api/help/*", requireUser);
app.use("/api/help", requireUser);
// Resolve bearer-token auth for the Obsidian plugin BEFORE requireUser runs,
// so the plugin can hit /api/addons/obsidian/vault.zip without a session cookie.
app.use("/api/addons/obsidian/vault.zip", obsidianBearerLoader);
app.use("/api/addons/*", requireUser);
// MCP endpoint — Streamable HTTP, stateless. Auth is bearer-token only
// (Cowork dispatch, Hermes Agent, third-party MCP clients hit this with
// `Authorization: Bearer hms_…`). Cookie sessions are not expected here
// so we don't add the standard requireUser — we use a dedicated gate.
app.use("/api/mcp", hermesBearerLoader, requireUser);
app.use("/api/mcp/*", hermesBearerLoader, requireUser);
app.use(
  "/api/models/*",
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use(
  "/api/models",
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
// /api/guest/session is the public snapshot endpoint — gated inside the route.
app.use("/api/guest/*", guestSessionLoader);
app.use("/api/admin/*", requireUser);
app.use("/api/agent-tokens", requireUser);
app.use("/api/agent-tokens/*", requireUser);

app.route("/api/conversations", conversationsRoute);
app.route("/api/chat", chatRoute);
app.route("/api/projects", projectsRoute);
// Project memory routes are also mounted under /api/projects (they share
// the :id path prefix) — order matters in Hono only when handlers conflict;
// here they don't, both can coexist on the same mount.
app.route("/api/projects", projectMemoryRoute);
app.route("/api/profile", profileRoute);
// Global user memory vault — ZIP import + external filesystem path,
// the user-scoped twin of /api/projects/:id/memory. Mounted under
// /api/profile/vault for namespace tidiness (profile is the existing
// user-scoped surface).
app.route("/api/profile/vault", userMemoryRoute);
app.route("/api/files", filesRoute);
app.route("/api/tts", ttsRoute);
app.route("/api/addons", addonsRoute);
app.route("/api/mcp", mcpRoute);
app.route("/api/addons/obsidian", obsidianRoute);
app.route("/api/addons/tavily", tavilyRoute);
app.route("/api/addons/voice-live", voiceLiveAddonRoute);
app.route("/api/addons/router", routerAddonRoute);
app.route("/api/addons/hermes", hermesAddonRoute);
app.route("/api/agents/hermes", hermesAgentRoute);
app.route("/api/help", helpRoute);
app.route("/api/models", modelsRoute);
app.route("/api/inference", inferenceRoute);
app.route("/api/inference/presets", inferencePresetsRoute);
app.route("/api/saved-prompts", savedPromptsRoute);
app.route("/api/providers", providersRoute);
app.route("/api/mcp-servers", mcpServersRoute);
app.route("/api/skills", skillsRoute);
// Public OAuth callback — gated only by `state` (PKCE + 10-min TTL).
// Notion's redirect lands here as a cross-origin top-level navigation
// without our session cookie, so it can't sit under /api/mcp-servers/*.
app.get("/api/mcp-oauth/callback", handleOauthCallback);
app.route("/api/admin/users", adminUsersRoute);
app.route("/api/admin/guest-tokens", adminGuestTokensRoute);
app.route("/api/agent-tokens", agentTokensRoute);
app.route("/api/guest", guestRoute);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT ?? 3001);

async function main() {
  await runMigrations();
  await seedIfEmpty();
  await ensureAdminExists();
  // Index the user-guide corpus for `/help` BM25 search. Cheap (~22 .md
  // files, ~50 KB total) — done once at boot, cached in process memory.
  loadHelpCorpus();
  startMemoryScheduler();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`→ companion api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("fatal: server failed to start", err);
  process.exit(1);
});
