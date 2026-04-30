import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { runMigrations } from "./db/migrate";
import { ensureAdminExists, seedIfEmpty } from "./db/seed";
import { requireUser, sessionLoader } from "./middleware/auth";
import { licenseGate } from "./middleware/license";
import addonsRoute from "./routes/addons";
import exoAddonRoute from "./routes/addon-exo";
import hermesAddonRoute from "./routes/addon-hermes";
import obsidianRoute, { obsidianBearerLoader } from "./routes/addon-obsidian";
import tavilyRoute from "./routes/addon-tavily";
import adminGroupsRoute from "./routes/admin-groups";
import adminNodesRoute from "./routes/admin-nodes";
import adminUsersRoute from "./routes/admin-users";
import authRoute from "./routes/auth";
import chatRoute from "./routes/chat";
import conversationsRoute from "./routes/conversations";
import inferenceRoute from "./routes/inference";
import licenseRoute from "./routes/license";
import modelsRoute from "./routes/models";
import projectsRoute from "./routes/projects";
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

// License gate + user gate on everything else
app.use("/api/conversations/*", licenseGate, requireUser);
app.use("/api/chat/*", licenseGate, requireUser);
app.use("/api/projects/*", licenseGate, requireUser);
app.use("/api/tts/*", licenseGate, requireUser);
app.use("/api/inference/*", licenseGate, requireUser);
// Resolve bearer-token auth for the Obsidian plugin BEFORE requireUser runs,
// so the plugin can hit /api/addons/obsidian/vault.zip without a session cookie.
app.use("/api/addons/obsidian/vault.zip", obsidianBearerLoader);
app.use("/api/addons/*", licenseGate, requireUser);
app.use("/api/models/*", licenseGate, requireUser);
app.use("/api/models", licenseGate, requireUser);
app.use("/api/admin/*", licenseGate, requireUser);

app.route("/api/conversations", conversationsRoute);
app.route("/api/chat", chatRoute);
app.route("/api/projects", projectsRoute);
app.route("/api/tts", ttsRoute);
app.route("/api/addons", addonsRoute);
app.route("/api/addons/obsidian", obsidianRoute);
app.route("/api/addons/tavily", tavilyRoute);
app.route("/api/addons/hermes", hermesAddonRoute);
app.route("/api/addons/exo", exoAddonRoute);
app.route("/api/models", modelsRoute);
app.route("/api/inference", inferenceRoute);
app.route("/api/admin/users", adminUsersRoute);
app.route("/api/admin/nodes", adminNodesRoute);
app.route("/api/admin/groups", adminGroupsRoute);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT ?? 3001);

async function main() {
  await runMigrations();
  await seedIfEmpty();
  await ensureAdminExists();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`→ thecomp.ai api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("fatal: server failed to start", err);
  process.exit(1);
});
