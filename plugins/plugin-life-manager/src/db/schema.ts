import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
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
}, (table) => ({
  inputRefsObject: check(
    "lm_work_items_input_refs_object",
    sql`jsonb_typeof(${table.inputRefs}) = 'object' AND octet_length(${table.inputRefs}::text) <= 16384`,
  ),
  tenantGraphIdx: index("idx_lm_work_items_tenant_graph").on(
    table.agentId,
    table.entityId,
    table.planGraphId,
  ),
}));

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
}, (table) => ({
  scopeEffectUnique: unique("lm_effect_intents_scope_effect_key_unique").on(
    table.agentId,
    table.entityId,
    table.effectKey,
  ),
  inputRefsObject: check(
    "lm_effect_intents_input_refs_object",
    sql`jsonb_typeof(${table.inputRefs}) = 'object' AND octet_length(${table.inputRefs}::text) <= 16384`,
  ),
  attemptNonNegative: check("lm_effect_intents_attempt_nonnegative", sql`${table.attempt} >= 0`),
  leaseCoherent: check(
    "lm_effect_intents_lease_coherent",
    sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
  ),
}));

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
}, (table) => ({
  scopeAttemptUnique: unique("lm_outcome_receipts_scope_attempt_unique").on(
    table.agentId,
    table.entityId,
    table.effectIntentId,
    table.attempt,
  ),
  receiptObject: check(
    "lm_outcome_receipts_receipt_object",
    sql`jsonb_typeof(${table.receipt}) = 'object' AND octet_length(${table.receipt}::text) <= 16384`,
  ),
}));

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
    entryKey: text("entry_key").notNull(),
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
  (table) => ({
    scopeEntryUnique: unique("lm_economic_receipts_scope_entry_key_unique").on(
      table.agentId,
      table.entityId,
      table.entryKey,
    ),
    entryKeyLength: check(
      "lm_economic_receipts_entry_key_length",
      sql`char_length(${table.entryKey}) BETWEEN 1 AND 256`,
    ),
    minorAmount: check(
      "lm_economic_receipts_amount_minor",
      sql`${table.amountMinor} IS NULL OR (${table.amountMinor} = trunc(${table.amountMinor}) AND ${table.amountMinor} >= 0 AND ${table.amountMinor} <= 9007199254740991)`,
    ),
    atomicAmount: check(
      "lm_economic_receipts_amount_atomic",
      sql`${table.amountAtomic} IS NULL OR (${table.amountAtomic} = trunc(${table.amountAtomic}) AND ${table.amountAtomic} >= 0 AND ${table.amountAtomic} <= 90071992547409910000)`,
    ),
    amountRepresentation: check(
      "lm_economic_receipts_amount_representation",
      sql`(${table.amountMinor} IS NOT NULL AND ${table.amountAtomic} IS NULL AND ${table.amountDecimals} IS NULL) OR (${table.amountMinor} IS NULL AND ${table.amountAtomic} IS NOT NULL AND ${table.amountDecimals} BETWEEN 0 AND 6)`,
    ),
    currencyFormat: check(
      "lm_economic_receipts_currency_format",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  }),
);

export type EconomicReceiptRow = typeof economicReceiptsTable.$inferSelect;
export type EconomicReceiptInsert = typeof economicReceiptsTable.$inferInsert;
