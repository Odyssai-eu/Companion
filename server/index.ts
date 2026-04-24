import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { runMigrations } from "./db/migrate";
import { seedIfEmpty } from "./db/seed";
import serversRoute from "./routes/servers";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../../package.json"), "utf8"),
) as { version: string };

const app = new Hono();

app.use("*", logger());

app.get("/api/health", (c) =>
  c.json({
    status: "ok" as const,
    version: pkg.version,
    engines: 0,
  }),
);

app.route("/api/servers", serversRoute);

if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist/client" }));
  app.get("*", serveStatic({ path: "./dist/client/index.html" }));
}

const port = Number(process.env.PORT ?? 3001);

async function main() {
  await runMigrations();
  await seedIfEmpty();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`→ thecomp.ai api listening on :${info.port}`);
  });
}

main().catch((err) => {
  console.error("fatal: server failed to start", err);
  process.exit(1);
});
