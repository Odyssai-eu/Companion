import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://companion:companion@localhost:5432/companion";

export const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

export type DB = typeof db;
