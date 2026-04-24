import { sql } from "drizzle-orm";
import { db } from "./index";
import { endpoints, servers, users } from "./schema";

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

  const [sophie] = await db
    .insert(users)
    .values({
      email: "d.sophie27@gmail.com",
      name: "Sophie",
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
      node: "exo1",
      ip: "192.168.86.29",
      port: 52415,
      latencyMs: 18,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "exo2",
      ip: "192.168.86.30",
      port: 52415,
      latencyMs: 21,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "exo3",
      ip: "192.168.86.31",
      port: 52415,
      latencyMs: 24,
    },
    {
      serverId: home.id,
      label: "EXO Endpoint",
      role: "secondary",
      node: "exo4",
      ip: "192.168.86.32",
      port: 52415,
      latencyMs: 19,
    },
  ]);

  console.log("→ seed complete");
}
