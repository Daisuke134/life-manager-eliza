import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  goalsTable,
  lifeManagerDbSchema,
  planGraphsTable,
  workItemsTable,
  type GoalRow,
  type PlanGraphInsert,
  type WorkItemInsert,
} from "./db/schema.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgColumn } from "drizzle-orm/pg-core";

export type GoalRef = `life-manager-goal://${string}/${string}/${string}`;

export type GoalWorkItemResult = Readonly<{
  planGraph: PlanGraphInsert;
  workItem: WorkItemInsert;
}>;

export const GOAL_WORK_ITEM_NOT_ACTIVE = "GOAL_NOT_ACTIVE" as const;
export const GOAL_WORK_ITEM_SUPERSEDED = "GOAL_SUPERSEDED" as const;
export const GOAL_WORK_ITEM_CONFLICT = "GOAL_WORK_ITEM_CONFLICT" as const;
export type GoalWorkItemFailureCode =
  | typeof GOAL_WORK_ITEM_NOT_ACTIVE
  | typeof GOAL_WORK_ITEM_SUPERSEDED
  | typeof GOAL_WORK_ITEM_CONFLICT;

export class GoalWorkItemError extends Error {
  readonly code: GoalWorkItemFailureCode;

  constructor(
    code: GoalWorkItemFailureCode = GOAL_WORK_ITEM_NOT_ACTIVE,
    message = "WorkItem requires one active Goal",
  ) {
    super(message);
    this.code = code;
    this.name = "GoalWorkItemError";
  }
}

function assertActiveGoal(goal: GoalRow, now: Date): void {
  const expiresAt = goal?.expiresAt;
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    goal?.status !== "active" ||
    (expiresAt !== null &&
      (!(expiresAt instanceof Date) ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= now.getTime()))
  ) {
    throw new GoalWorkItemError();
  }
}

export function buildGoalWorkItemRows(goal: GoalRow, now: Date): GoalWorkItemResult {
  assertActiveGoal(goal, now);

  const goalRef =
    `life-manager-goal://${goal.agentId}/${goal.entityId}/${goal.id}` as GoalRef;
  const planGraph: PlanGraphInsert = Object.freeze({
    id: goal.id,
    agentId: goal.agentId,
    entityId: goal.entityId,
    goalId: goal.id,
    graph: Object.freeze({ version: 1, goal_ref: goalRef }),
    status: "reference_only",
  });
  const workItem: WorkItemInsert = Object.freeze({
    id: goal.id,
    agentId: goal.agentId,
    entityId: goal.entityId,
    planGraphId: goal.id,
    capability: "general-agent.work",
    inputRefs: Object.freeze({ goal_ref: goalRef }),
    status: "pending",
  });

  return Object.freeze({ planGraph, workItem });
}

export interface GoalWorkItemPersistenceInput {
  agentId: GoalRow["agentId"];
  entityId: GoalRow["entityId"];
  goalId: GoalRow["id"];
  now: Date;
}

export type GoalWorkItemDatabase = NodePgDatabase<typeof lifeManagerDbSchema>;

const PLAN_GRAPH_FIELDS = [
  "id", "agentId", "entityId", "goalId", "graph", "status",
];
const WORK_ITEM_FIELDS = [
  "id", "agentId", "entityId", "planGraphId", "capability", "inputRefs", "status",
];

type ScopedTable = { id: PgColumn; agentId: PgColumn; entityId: PgColumn };

function tenantScope(table: ScopedTable, input: GoalWorkItemPersistenceInput) {
  return and(eq(table.agentId, input.agentId), eq(table.entityId, input.entityId));
}

function goalScope(table: ScopedTable, input: GoalWorkItemPersistenceInput) {
  return and(tenantScope(table, input), eq(table.id, input.goalId));
}

function sameContract(
  row: unknown,
  expected: Record<string, unknown>,
  fields: string[],
): boolean {
  if (!row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  return fields.every(
    (field) => isDeepStrictEqual(value[field], expected[field]),
  );
}

export async function persistGoalWorkItem(
  db: GoalWorkItemDatabase,
  input: GoalWorkItemPersistenceInput,
): Promise<GoalWorkItemResult> {
  if (!(input?.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new GoalWorkItemError();
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${goalsTable} IN SHARE MODE`);
    const [goal] = await tx
      .select()
      .from(goalsTable)
      .where(goalScope(goalsTable, input))
      .limit(1);
    if (!goal) throw new GoalWorkItemError();
    assertActiveGoal(goal, input.now);

    const [superseder] = await tx
      .select({ id: goalsTable.id })
      .from(goalsTable)
      .where(
        and(
          tenantScope(goalsTable, input),
          eq(goalsTable.supersedes, input.goalId),
          eq(goalsTable.status, "active"),
          or(isNull(goalsTable.expiresAt), gt(goalsTable.expiresAt, input.now)),
        ),
      )
      .limit(1);
    if (superseder) {
      throw new GoalWorkItemError(
        GOAL_WORK_ITEM_SUPERSEDED,
        "WorkItem requires an active Goal without an active superseder",
      );
    }

    const expected = buildGoalWorkItemRows(goal, input.now);
    await tx
      .insert(planGraphsTable)
      .values(expected.planGraph)
      .onConflictDoNothing({
        target: [
          planGraphsTable.agentId,
          planGraphsTable.entityId,
          planGraphsTable.goalId,
        ],
      });

    const [storedPlanGraph] = await tx
      .select()
      .from(planGraphsTable)
      .where(
        and(
          eq(planGraphsTable.agentId, input.agentId),
          eq(planGraphsTable.entityId, input.entityId),
          eq(planGraphsTable.goalId, input.goalId),
        ),
      )
      .limit(1);
    if (
      !sameContract(
        storedPlanGraph,
        expected.planGraph as Record<string, unknown>,
        PLAN_GRAPH_FIELDS,
      )
    ) {
      throw new GoalWorkItemError(
        GOAL_WORK_ITEM_CONFLICT,
        "WorkItem persistence conflicts with existing PlanGraph",
      );
    }

    await tx
      .insert(workItemsTable)
      .values(expected.workItem)
      .onConflictDoNothing({
        target: [
          workItemsTable.agentId,
          workItemsTable.entityId,
          workItemsTable.planGraphId,
        ],
      });

    const [storedWorkItem] = await tx
      .select()
      .from(workItemsTable)
      .where(
        and(
          eq(workItemsTable.agentId, input.agentId),
          eq(workItemsTable.entityId, input.entityId),
          eq(workItemsTable.planGraphId, input.goalId),
        ),
      )
      .limit(1);
    if (
      !sameContract(
        storedWorkItem,
        expected.workItem as Record<string, unknown>,
        WORK_ITEM_FIELDS,
      )
    ) {
      throw new GoalWorkItemError(
        GOAL_WORK_ITEM_CONFLICT,
        "WorkItem persistence conflicts with existing rows",
      );
    }
    return expected;
  });
}
