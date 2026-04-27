import { sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { addons, endpoints, servers, users } from "./schema";

/**
 * Seed dev data on an empty DB. Idempotent — checks if users table is empty
 * before inserting. Safe to call on every startup.
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) return;

  console.log("→ seeding empty DB with dev data");

  // Dev account — Sophie logs in with `dev` initially, can change via API.
  const passwordHash = await hashPassword("dev");
  const [sophie] = await db
    .insert(users)
    .values({
      email: "d.sophie27@gmail.com",
      name: "Sophie",
      passwordHash,
    })
    .returning();

  const [home] = await db
    .insert(servers)
    .values({
      userId: sophie.id,
      name: "Home Mac Studios",
      url: "http://192.168.86.29:52415",
      description:
        "4 Mac Studios in a Thunderbolt mesh, running exo v1.0.70. Secondary endpoints reach each node directly.",
    })
    .returning();

  await db.insert(servers).values([
    {
      userId: sophie.id,
      name: "Office server",
      hint: "via Tailscale",
      url: "https://macstudio-office.ts.net",
    },
    {
      userId: sophie.id,
      name: "Client lab — Paris",
      url: "https://lab.acme.example:52415",
    },
  ]);

  await db.insert(endpoints).values([
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "primary",
      node: "ultra-512",
      ip: "192.168.86.29",
      port: 52415,
      latencyMs: 18,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "ultra-256a",
      ip: "192.168.86.30",
      port: 52415,
      latencyMs: 21,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "ultra-256b",
      ip: "192.168.86.31",
      port: 52415,
      latencyMs: 24,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "ultra-256c",
      ip: "192.168.86.32",
      port: 52415,
      latencyMs: 19,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "ultra-96",
      ip: "192.168.86.49",
      port: 52415,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "ultra-96b",
      ip: "192.168.86.42",
      port: 52415,
    },
  ]);

  await db.insert(addons).values([
    {
      userId: sophie.id,
      name: "Admin — Simple",
      kind: "core",
      description:
        "Invite users, manage roles, revoke devices. Installed by default on Team plans.",
      version: "1.0.0",
      enabled: true,
    },
    {
      userId: sophie.id,
      name: "Admin — Extended",
      kind: "core",
      description:
        "Audit log, SSO, usage analytics, billing reconciliation, infra diagnostics à la Starbase. Activate when you need it.",
      version: "1.0.0",
      enabled: false,
    },
    {
      userId: sophie.id,
      name: "Voice Mode",
      kind: "plugin",
      description:
        "Full-duplex audio via VibeVoice-Realtime. EN only for now; falls back to Voxtral batch when the realtime service is down.",
      version: "0.3.2",
      enabled: false,
    },
    {
      userId: sophie.id,
      name: "Audiobook",
      kind: "plugin",
      description:
        "Turn long documents into voiced MP3s. Voxtral TTS with prosody-aware LLM splitting, speed slider, Google Drive delivery.",
      version: "1.2.0",
      enabled: false,
    },
    {
      userId: sophie.id,
      name: "Obsidian",
      kind: "plugin",
      description:
        "Read-only sync of your memory wiki to an Obsidian vault. Install the companion plugin and paste your sync token.",
      version: "0.1.0",
      enabled: false,
    },
    {
      userId: sophie.id,
      name: "Notion",
      kind: "mcp",
      description:
        "Query pages, create databases, push conversation summaries into your Notion workspaces.",
      version: "0.9.0",
      enabled: false,
    },
  ]);

  console.log("→ seed complete");
}
