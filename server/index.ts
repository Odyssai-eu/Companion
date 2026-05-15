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
import { licenseGate } from "./middleware/license";
import addonsRoute from "./routes/addons";
import hermesAddonRoute from "./routes/addon-hermes";
import hermesBridgeRoute from "./routes/hermes-bridge";
import mcpRoute from "./routes/mcp";
import voiceLiveAddonRoute from "./routes/addon-voice-live";
import obsidianRoute, { obsidianBearerLoader } from "./routes/addon-obsidian";
import tavilyRoute from "./routes/addon-tavily";
import adminGuestTokensRoute from "./routes/admin-guest-tokens";
import adminUsersRoute from "./routes/admin-users";
import authRoute from "./routes/auth";
import chatRoute from "./routes/chat";
import conversationsRoute from "./routes/conversations";
import filesRoute from "./routes/files";
import guestRoute from "./routes/guest";
import inferenceRoute from "./routes/inference";
import inferencePresetsRoute from "./routes/inference-presets";
import licenseRoute from "./routes/license";
import modelsRoute from "./routes/models";
import profileRoute from "./routes/profile";
import projectMemoryRoute from "./routes/project-memory";
import projectsRoute from "./routes/projects";
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
app.route("/api/license", licenseRoute);

// License gate + user gate on everything else.
// hermesBearerLoader resolves `Authorization: Bearer hms_<…>` into a real
// userId BEFORE requireUser runs, so the thecompai-mcp MCP server (Hermes
// Agent on .50, Cowork dispatch) can hit these routes without a cookie.
app.use("/api/conversations/*", licenseGate, hermesBearerLoader, requireUser);
// Chat, models, and inference accept guest tokens (Bearer / ?g= / cookie)
// in addition to regular sessions. License still applies — guests count
// against the inviting admin's license.
app.use(
  "/api/chat/*",
  licenseGate,
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use("/api/projects/*", licenseGate, hermesBearerLoader, requireUser);
app.use("/api/profile/*", licenseGate, requireUser);
app.use("/api/profile", licenseGate, requireUser);
app.use("/api/files/*", licenseGate, hermesBearerLoader, requireUser);
app.use("/api/files", licenseGate, hermesBearerLoader, requireUser);
app.use("/api/tts/*", licenseGate, requireUser);
app.use(
  "/api/inference/*",
  licenseGate,
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use("/api/providers/*", licenseGate, requireUser);
// Resolve bearer-token auth for the Obsidian plugin BEFORE requireUser runs,
// so the plugin can hit /api/addons/obsidian/vault.zip without a session cookie.
app.use("/api/addons/obsidian/vault.zip", obsidianBearerLoader);
app.use("/api/addons/*", licenseGate, requireUser);
app.use("/api/hermes-bridge/*", licenseGate, hermesBearerLoader, requireUser);
// MCP endpoint — Streamable HTTP, stateless. Auth is bearer-token only
// (Cowork dispatch, Hermes Agent, third-party MCP clients hit this with
// `Authorization: Bearer hms_…`). Cookie sessions are not expected here
// so we don't add the standard requireUser — we use a dedicated gate.
app.use("/api/mcp", licenseGate, hermesBearerLoader, requireUser);
app.use("/api/mcp/*", licenseGate, hermesBearerLoader, requireUser);
app.use(
  "/api/models/*",
  licenseGate,
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
app.use(
  "/api/models",
  licenseGate,
  hermesBearerLoader,
  guestSessionLoader,
  requireUserOrGuest,
);
// /api/guest/session is the public snapshot endpoint — gated inside the route.
app.use("/api/guest/*", licenseGate, guestSessionLoader);
app.use("/api/admin/*", licenseGate, requireUser);

app.route("/api/conversations", conversationsRoute);
app.route("/api/chat", chatRoute);
app.route("/api/projects", projectsRoute);
// Project memory routes are also mounted under /api/projects (they share
// the :id path prefix) — order matters in Hono only when handlers conflict;
// here they don't, both can coexist on the same mount.
app.route("/api/projects", projectMemoryRoute);
app.route("/api/profile", profileRoute);
app.route("/api/files", filesRoute);
app.route("/api/tts", ttsRoute);
app.route("/api/addons", addonsRoute);
app.route("/api/hermes-bridge", hermesBridgeRoute);
app.route("/api/mcp", mcpRoute);
app.route("/api/addons/obsidian", obsidianRoute);
app.route("/api/addons/tavily", tavilyRoute);
app.route("/api/addons/hermes", hermesAddonRoute);
app.route("/api/addons/voice-live", voiceLiveAddonRoute);
app.route("/api/models", modelsRoute);
app.route("/api/inference", inferenceRoute);
app.route("/api/inference/presets", inferencePresetsRoute);
app.route("/api/providers", providersRoute);
app.route("/api/admin/users", adminUsersRoute);
app.route("/api/admin/guest-tokens", adminGuestTokensRoute);
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
  startMemoryScheduler();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`→ companion api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("fatal: server failed to start", err);
  process.exit(1);
});
