import { sql } from "drizzle-orm";
import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
