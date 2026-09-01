/**
 * Out-of-process worker for the same-PGlite restart proof (ELZ-C09-03).
 * Invoked twice by goal-reflection.restart.test.ts as two SEPARATE OS
 * processes against the SAME on-disk PGlite data dir:
 *   argv: mode ("write" | "read") dataDir agentId entityId goalId
 * "write": bootstraps the real life_manager schema, applies the existing
 *   production migration (migrateLifeManagerDomain), inserts one tenant-scoped
 *   Goal chain with a success case, a failure case, and cost/currency
 *   receipts, reads it back through the production readGoalReflection
 *   service, then closes the database.
 * "read": re-opens the same on-disk dir with zero writes and reads the same
 *   reflection back.
 * Both modes print one JSON line to stdout: { hash, counts, reflection }.
 */
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readGoalReflection, type GoalReflectionDatabase } from "./goal-reflection.js";
import { migrateLifeManagerDomain } from "./services/migration.js";

const DDL = `
CREATE SCHEMA IF NOT EXISTS life_manager;

CREATE TABLE IF NOT EXISTS life_manager.goals (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  statement text NOT NULL,
  provenance jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  supersedes uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS life_manager.plan_graphs (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  graph jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id),
  UNIQUE (agent_id, entity_id, goal_id),
  FOREIGN KEY (agent_id, entity_id, goal_id) REFERENCES life_manager.goals (agent_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS life_manager.work_items (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  plan_graph_id uuid NOT NULL,
  capability text NOT NULL,
  input_refs jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id),
  UNIQUE (agent_id, entity_id, plan_graph_id),
  FOREIGN KEY (agent_id, entity_id, plan_graph_id) REFERENCES life_manager.plan_graphs (agent_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS life_manager.effect_intents (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  effect_class text NOT NULL,
  effect_key text NOT NULL,
  input_refs jsonb NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned',
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id),
  UNIQUE (agent_id, entity_id, effect_key),
  FOREIGN KEY (agent_id, entity_id, work_item_id) REFERENCES life_manager.work_items (agent_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS life_manager.outcome_receipts (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  effect_intent_id uuid NOT NULL,
  attempt integer NOT NULL,
  outcome text NOT NULL,
  effect_key text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id),
  UNIQUE (agent_id, entity_id, effect_intent_id, attempt),
  FOREIGN KEY (agent_id, entity_id, effect_intent_id) REFERENCES life_manager.effect_intents (agent_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS life_manager.economic_receipts (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  outcome_receipt_id uuid NOT NULL,
  entry_key text NOT NULL,
  kind text NOT NULL,
  amount_minor numeric,
  amount_atomic numeric,
  amount_decimals smallint,
  currency text NOT NULL,
  verification_status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, entity_id, id),
  UNIQUE (agent_id, entity_id, entry_key),
  FOREIGN KEY (agent_id, entity_id, outcome_receipt_id) REFERENCES life_manager.outcome_receipts (agent_id, entity_id, id)
);
`;

const TABLE_NAMES = [
  "goals",
  "plan_graphs",
  "work_items",
  "effect_intents",
  "outcome_receipts",
  "economic_receipts",
] as const;

async function tableCounts(pg: PGlite): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLE_NAMES) {
    const result = await pg.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM life_manager.${table}`,
    );
    counts[table] = Number(result.rows[0]?.count ?? "0");
  }
  return counts;
}

async function writeFixture(
  pg: PGlite,
  ids: { agentId: string; entityId: string; goalId: string },
): Promise<void> {
  await pg.exec(DDL);
  await migrateLifeManagerDomain(async (statement) => {
    const result = await pg.query(statement);
    return result.rows as Array<Record<string, unknown>>;
  });

  const { agentId, entityId, goalId } = ids;
  const planGraphId = "00000000-0000-4000-8000-0000000000a1";
  const workItemId = "00000000-0000-4000-8000-0000000000a2";
  const successIntentId = "00000000-0000-4000-8000-0000000000a3";
  const failureIntentId = "00000000-0000-4000-8000-0000000000a4";
  const successReceiptId = "00000000-0000-4000-8000-0000000000a5";
  const failureReceiptId = "00000000-0000-4000-8000-0000000000a6";
  const revenueReceiptId = "00000000-0000-4000-8000-0000000000a7";
  const costReceiptId = "00000000-0000-4000-8000-0000000000a8";
  const fixedTime = "2026-08-30T00:00:00.000Z";

  await pg.query(
    `INSERT INTO life_manager.goals (id, agent_id, entity_id, statement, provenance)
     VALUES ($1, $2, $3, $4, $5)`,
    [goalId, agentId, entityId, "Earn one externally paid outcome", JSON.stringify({ source: "test" })],
  );
  await pg.query(
    `INSERT INTO life_manager.plan_graphs (id, agent_id, entity_id, goal_id, graph)
     VALUES ($1, $2, $3, $4, $5)`,
    [planGraphId, agentId, entityId, goalId, JSON.stringify({ version: 1 })],
  );
  await pg.query(
    `INSERT INTO life_manager.work_items (id, agent_id, entity_id, plan_graph_id, capability, input_refs)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workItemId, agentId, entityId, planGraphId, "general-agent.work", JSON.stringify({})],
  );
  await pg.query(
    `INSERT INTO life_manager.effect_intents
       (id, agent_id, entity_id, work_item_id, effect_class, effect_key, input_refs, attempt, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'completed')`,
    [successIntentId, agentId, entityId, workItemId, "gig.apply", "effect-restart-success", JSON.stringify({})],
  );
  await pg.query(
    `INSERT INTO life_manager.effect_intents
       (id, agent_id, entity_id, work_item_id, effect_class, effect_key, input_refs, attempt, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'failed')`,
    [failureIntentId, agentId, entityId, workItemId, "gig.apply", "effect-restart-failure", JSON.stringify({})],
  );
  await pg.query(
    `INSERT INTO life_manager.outcome_receipts
       (id, agent_id, entity_id, effect_intent_id, attempt, outcome, effect_key, receipt)
     VALUES ($1, $2, $3, $4, 0, 'success', $5, $6)`,
    [
      successReceiptId,
      agentId,
      entityId,
      successIntentId,
      "effect-restart-success",
      JSON.stringify({ status: 200 }),
    ],
  );
  await pg.query(
    `INSERT INTO life_manager.outcome_receipts
       (id, agent_id, entity_id, effect_intent_id, attempt, outcome, effect_key, receipt)
     VALUES ($1, $2, $3, $4, 1, 'failure', $5, $6)`,
    [
      failureReceiptId,
      agentId,
      entityId,
      failureIntentId,
      "effect-restart-failure",
      JSON.stringify({ failure: { code: "PROVIDER_TIMEOUT" } }),
    ],
  );
  await pg.query(
    `INSERT INTO life_manager.economic_receipts
       (id, agent_id, entity_id, outcome_receipt_id, entry_key, kind, amount_minor, currency, verification_status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'revenue', $6, $7, 'verified', $8)`,
    [revenueReceiptId, agentId, entityId, successReceiptId, "entry-restart-revenue", "1500", "USD", fixedTime],
  );
  await pg.query(
    `INSERT INTO life_manager.economic_receipts
       (id, agent_id, entity_id, outcome_receipt_id, entry_key, kind, amount_minor, currency, verification_status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'cost', $6, $7, 'verified', $8)`,
    [costReceiptId, agentId, entityId, failureReceiptId, "entry-restart-cost", "200", "USD", fixedTime],
  );
}

async function main(): Promise<void> {
  const [, , mode, dataDir, agentId, entityId, goalId] = process.argv;
  if (mode !== "write" && mode !== "read") {
    throw new Error(`unknown mode: ${mode}`);
  }
  if (!dataDir || !agentId || !entityId || !goalId) {
    throw new Error("missing required argv: mode dataDir agentId entityId goalId");
  }

  const pg = new PGlite(dataDir);
  try {
    if (mode === "write") {
      await writeFixture(pg, { agentId, entityId, goalId });
    }

    const db = drizzle(pg) as unknown as GoalReflectionDatabase;
    const reflection = await readGoalReflection(db, { agentId, entityId, goalId });
    const counts = await tableCounts(pg);
    const hash = createHash("sha256").update(JSON.stringify(reflection)).digest("hex");
    process.stdout.write(JSON.stringify({ mode, pid: process.pid, hash, counts, reflection }));
  } finally {
    await pg.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
