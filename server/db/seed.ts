import { sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { addons, users } from "./schema";

/**
 * Seed dev data on an empty DB. Idempotent — checks if users table is empty
 * before inserting. Safe to call on every startup.
 *
 * v0.1.0 — no more servers/endpoints seed. Inference is now via LiteLLM,
 * configured per-user in Settings → Inference (or via the LITELLM_URL env
 * default). The default URL points at Sophie's home cluster proxy.
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
      // Personal default — falls back to env LITELLM_URL otherwise.
      litellmUrl: "http://192.168.86.44:4000",
      timezone: "Europe/Brussels",
    })
    .returning();

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
  ]);

  console.log("→ seed complete");
}
