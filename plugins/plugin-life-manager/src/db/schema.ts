import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const lifeManagerSchema = pgSchema("life_manager");

export const goalsTable = lifeManagerSchema.table("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  statement: text("statement").notNull(),
  provenance: jsonb("provenance").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  supersedes: uuid("supersedes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type GoalRow = typeof goalsTable.$inferSelect;
export type GoalInsert = typeof goalsTable.$inferInsert;

export const planGraphsTable = lifeManagerSchema.table("plan_graphs", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => goalsTable.id),
  graph: jsonb("graph").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type PlanGraphRow = typeof planGraphsTable.$inferSelect;
export type PlanGraphInsert = typeof planGraphsTable.$inferInsert;

export const workItemsTable = lifeManagerSchema.table("work_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  planGraphId: uuid("plan_graph_id")
    .notNull()
    .references(() => planGraphsTable.id),
  capability: text("capability").notNull(),
  inputRefs: jsonb("input_refs").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type WorkItemRow = typeof workItemsTable.$inferSelect;
export type WorkItemInsert = typeof workItemsTable.$inferInsert;

export const effectIntentsTable = lifeManagerSchema.table("effect_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  workItemId: uuid("work_item_id")
    .notNull()
    .references(() => workItemsTable.id),
  effectClass: text("effect_class").notNull(),
  effectKey: text("effect_key").notNull(),
  inputRefs: jsonb("input_refs").notNull(),
  attempt: integer("attempt").notNull().default(0),
  status: text("status").notNull().default("planned"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type EffectIntentRow = typeof effectIntentsTable.$inferSelect;
export type EffectIntentInsert = typeof effectIntentsTable.$inferInsert;

export const outcomeReceiptsTable = lifeManagerSchema.table("outcome_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  effectIntentId: uuid("effect_intent_id")
    .notNull()
    .references(() => effectIntentsTable.id),
  attempt: integer("attempt").notNull(),
  outcome: text("outcome").notNull(),
  effectKey: text("effect_key").notNull(),
  receipt: jsonb("receipt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type OutcomeReceiptRow = typeof outcomeReceiptsTable.$inferSelect;
export type OutcomeReceiptInsert = typeof outcomeReceiptsTable.$inferInsert;

export const economicReceiptsTable = lifeManagerSchema.table(
  "economic_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    outcomeReceiptId: uuid("outcome_receipt_id")
      .notNull()
      .references(() => outcomeReceiptsTable.id),
    kind: text("kind").notNull(),
    amountMinor: numeric("amount_minor"),
    amountAtomic: numeric("amount_atomic"),
    amountDecimals: smallint("amount_decimals"),
    currency: text("currency").notNull(),
    verificationStatus: text("verification_status").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
);

export type EconomicReceiptRow = typeof economicReceiptsTable.$inferSelect;
export type EconomicReceiptInsert = typeof economicReceiptsTable.$inferInsert;
