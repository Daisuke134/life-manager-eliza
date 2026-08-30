import { type IAgentRuntime, Service } from "@elizaos/core";
import { sql } from "drizzle-orm";

export const LIFE_MANAGER_MIGRATION_SERVICE_TYPE = "life_manager_migration";
export const LIFE_MANAGER_DOMAIN_TABLES = [
  "goals",
  "plan_graphs",
  "work_items",
  "effect_intents",
  "outcome_receipts",
  "economic_receipts",
] as const;

const SCHEMA = "life_manager";
const MARKER_TABLE = "life_manager_migration_state";
const MIGRATION_KEY = "domain-v1-receipt-immutability";
const RECEIPT_TABLES = ["outcome_receipts", "economic_receipts"] as const;

export type SqlExecutor = (
  statement: string,
) => Promise<Array<Record<string, unknown>>>;

export async function migrateLifeManagerDomain(exec: SqlExecutor): Promise<{
  outcome: "installed" | "already-migrated";
  tables: string[];
}> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await exec(
    `CREATE TABLE IF NOT EXISTS ${SCHEMA}.${MARKER_TABLE} (
       migration_key TEXT PRIMARY KEY,
       migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const rows = await exec(
    `SELECT EXISTS (
       SELECT 1 FROM ${SCHEMA}.${MARKER_TABLE}
       WHERE migration_key = '${MIGRATION_KEY}'
     ) AS done`,
  );
  if (rows[0]?.done === true || rows[0]?.done === "true") {
    return { outcome: "already-migrated", tables: [...LIFE_MANAGER_DOMAIN_TABLES] };
  }

  await exec(
    `CREATE OR REPLACE FUNCTION ${SCHEMA}.reject_receipt_mutation()
     RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'Life Manager receipts are immutable';
     END
     $$`,
  );
  for (const table of RECEIPT_TABLES) {
    await exec(`DROP TRIGGER IF EXISTS ${table}_immutable ON ${SCHEMA}.${table}`);
    await exec(
      `CREATE TRIGGER ${table}_immutable
       BEFORE UPDATE OR DELETE ON ${SCHEMA}.${table}
       FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.reject_receipt_mutation()`,
    );
  }
  await exec(
    `INSERT INTO ${SCHEMA}.${MARKER_TABLE} (migration_key)
     VALUES ('${MIGRATION_KEY}')
     ON CONFLICT (migration_key) DO NOTHING`,
  );
  return { outcome: "installed", tables: [...LIFE_MANAGER_DOMAIN_TABLES] };
}

type RuntimeDb = { execute: (query: unknown) => Promise<unknown> };

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return [];
}

export class LifeManagerMigrationService extends Service {
  static override readonly serviceType = LIFE_MANAGER_MIGRATION_SERVICE_TYPE;
  override capabilityDescription =
    "Installs one-shot, non-destructive Life Manager receipt immutability guards.";

  static async start(runtime: IAgentRuntime): Promise<LifeManagerMigrationService> {
    const service = new LifeManagerMigrationService(runtime);
    const db = runtime.db as RuntimeDb | undefined;
    if (!db || typeof db.execute !== "function") {
      throw new Error("Life Manager migration requires @elizaos/plugin-sql");
    }
    await migrateLifeManagerDomain(async (statement) =>
      rowsFrom(await db.execute(sql.raw(statement))),
    );
    return service;
  }

  override async stop(): Promise<void> {}
}
