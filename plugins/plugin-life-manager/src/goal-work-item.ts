import type { GoalRow, PlanGraphInsert, WorkItemInsert } from "./db/schema.ts";

export type GoalRef = `life-manager-goal://${string}/${string}/${string}`;

export type GoalWorkItemResult = Readonly<{
  planGraph: PlanGraphInsert;
  workItem: WorkItemInsert;
}>;

export const GOAL_WORK_ITEM_NOT_ACTIVE = "GOAL_NOT_ACTIVE" as const;
export type GoalWorkItemFailureCode = typeof GOAL_WORK_ITEM_NOT_ACTIVE;

export class GoalWorkItemError extends Error {
  readonly code: GoalWorkItemFailureCode = GOAL_WORK_ITEM_NOT_ACTIVE;

  constructor() {
    super("WorkItem requires one active Goal");
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
      (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()))
  ) {
    throw new GoalWorkItemError();
  }
}

export function buildGoalWorkItemRows(goal: GoalRow, now: Date): GoalWorkItemResult {
  assertActiveGoal(goal, now);

  const goalRef = `life-manager-goal://${goal.agentId}/${goal.entityId}/${goal.id}` as GoalRef;
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
