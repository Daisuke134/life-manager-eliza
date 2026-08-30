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
