import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  economicReceiptsTable,
  effectIntentsTable,
  goalsTable,
  lifeManagerDbSchema,
  outcomeReceiptsTable,
  planGraphsTable,
  workItemsTable,
} from "./db/schema.js";
import type { GoalRef } from "./goal-work-item.js";

export interface GoalReflectionReadInput {
  readonly agentId: string;
  readonly entityId: string;
  readonly goalId: string;
}

export type GoalReflectionOutcome = Readonly<{
  outcomeReceiptId: string;
  effectIntentId: string;
  attempt: number;
  outcome: string;
  effectKey: string;
  observedAt: string;
  failureCode: string | null;
}>;

export type GoalReflectionEconomic = Readonly<{
  economicReceiptId: string;
  outcomeReceiptId: string;
  kind: string;
  amountMinor: string | null;
  amountAtomic: string | null;
  amountDecimals: number | null;
  currency: string;
  verificationStatus: string;
  occurredAt: string;
}>;

export type GoalReflection = Readonly<{
  goalRef: GoalRef;
  outcomes: readonly GoalReflectionOutcome[];
  economics: readonly GoalReflectionEconomic[];
}>;

export type GoalReflectionDatabase = NodePgDatabase<typeof lifeManagerDbSchema>;

export const GOAL_REFLECTION_GOAL_NOT_FOUND =
  "GOAL_REFLECTION_GOAL_NOT_FOUND" as const;
export const GOAL_REFLECTION_NOT_FOUND = GOAL_REFLECTION_GOAL_NOT_FOUND;
export const GOAL_REFLECTION_INVALID_INPUT =
  "GOAL_REFLECTION_INVALID_INPUT" as const;
export const GOAL_REFLECTION_INVALID_ROW =
  "GOAL_REFLECTION_INVALID_ROW" as const;

export type GoalReflectionErrorCode =
  | typeof GOAL_REFLECTION_GOAL_NOT_FOUND
  | typeof GOAL_REFLECTION_INVALID_INPUT
  | typeof GOAL_REFLECTION_INVALID_ROW;

export class GoalReflectionError extends Error {
  readonly code: GoalReflectionErrorCode;

  constructor(code: GoalReflectionErrorCode, message: string) {
    super(message);
    this.name = "GoalReflectionError";
    this.code = code;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_REFERENCE_LENGTH = 512;
const MAX_TEXT_LENGTH = 16_384;
const MAX_FAILURE_CODE_LENGTH = 256;

type ScopedTable = { agentId: PgColumn; entityId: PgColumn };

function tenantScope(table: ScopedTable, input: GoalReflectionReadInput) {
  return and(eq(table.agentId, input.agentId), eq(table.entityId, input.entityId));
}

function normalizeInput(input: GoalReflectionReadInput): GoalReflectionReadInput {
  if (
    !input ||
    typeof input !== "object" ||
    !isBoundedText(input.agentId, MAX_REFERENCE_LENGTH) ||
    !isBoundedText(input.entityId, MAX_REFERENCE_LENGTH) ||
    !isBoundedText(input.goalId, MAX_REFERENCE_LENGTH)
  ) {
    throw new GoalReflectionError(
      GOAL_REFLECTION_INVALID_INPUT,
      "Goal reflection scope is invalid",
    );
  }
  return input;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL.test(value)
  );
}

function rowText(value: unknown, field: string, maximum = MAX_TEXT_LENGTH): string {
  if (!isBoundedText(value, maximum)) {
    throw new GoalReflectionError(
      GOAL_REFLECTION_INVALID_ROW,
      `Goal reflection row has invalid ${field}`,
    );
  }
  return value;
}

function rowTimestamp(value: unknown, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GoalReflectionError(
      GOAL_REFLECTION_INVALID_ROW,
      `Goal reflection row has invalid ${field}`,
    );
  }
  return value.toISOString();
}

function failureCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const failure = (value as Record<string, unknown>).failure;
  if (failure === null || typeof failure !== "object" || Array.isArray(failure)) {
    return null;
  }
  const code = (failure as Record<string, unknown>).code;
  if (!isBoundedText(code, MAX_FAILURE_CODE_LENGTH)) return null;
  return code.trim() || null;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function emptyReflection(goalRef: GoalRef): GoalReflection {
  return deepFreeze({ goalRef, outcomes: [], economics: [] });
}

export async function readGoalReflection(
  db: GoalReflectionDatabase,
  input: GoalReflectionReadInput,
): Promise<GoalReflection> {
  const scope = normalizeInput(input);
  const runtimeDb = db as unknown as {
    readonly select?: unknown;
    readonly transaction?: unknown;
  };
  if (
    typeof runtimeDb.select !== "function" ||
    typeof runtimeDb.transaction !== "function"
  ) {
    throw new Error("Life Manager Goal reflection requires plugin-sql runtime.db");
  }

  return db.transaction(async (tx) => {
    const [goal] = await tx
      .select({
        id: goalsTable.id,
        agentId: goalsTable.agentId,
        entityId: goalsTable.entityId,
      })
      .from(goalsTable)
      .where(and(tenantScope(goalsTable, scope), eq(goalsTable.id, scope.goalId)))
      .limit(1);
    if (!goal) {
      throw new GoalReflectionError(
        GOAL_REFLECTION_GOAL_NOT_FOUND,
        "Goal reflection requires an existing Goal",
      );
    }

    const goalRef =
      `life-manager-goal://${goal.agentId}/${goal.entityId}/${goal.id}` as GoalRef;
    const [planGraph] = await tx
      .select({ id: planGraphsTable.id })
      .from(planGraphsTable)
      .where(
        and(
          tenantScope(planGraphsTable, scope),
          eq(planGraphsTable.goalId, goal.id),
        ),
      )
      .limit(1);
    if (!planGraph) return emptyReflection(goalRef);

    const [workItem] = await tx
      .select({ id: workItemsTable.id })
      .from(workItemsTable)
      .where(
        and(
          tenantScope(workItemsTable, scope),
          eq(workItemsTable.planGraphId, planGraph.id),
        ),
      )
      .limit(1);
    if (!workItem) return emptyReflection(goalRef);

    const effectIntents = await tx
      .select({ id: effectIntentsTable.id })
      .from(effectIntentsTable)
      .where(
        and(
          tenantScope(effectIntentsTable, scope),
          eq(effectIntentsTable.workItemId, workItem.id),
        ),
      );
    if (effectIntents.length === 0) return emptyReflection(goalRef);

    const effectIntentIds = effectIntents.map(({ id }) => id);
    const outcomeRows = await tx
      .select({
        id: outcomeReceiptsTable.id,
        effectIntentId: outcomeReceiptsTable.effectIntentId,
        attempt: outcomeReceiptsTable.attempt,
        outcome: outcomeReceiptsTable.outcome,
        effectKey: outcomeReceiptsTable.effectKey,
        receipt: outcomeReceiptsTable.receipt,
        createdAt: outcomeReceiptsTable.createdAt,
      })
      .from(outcomeReceiptsTable)
      .where(
        and(
          tenantScope(outcomeReceiptsTable, scope),
          inArray(outcomeReceiptsTable.effectIntentId, effectIntentIds),
        ),
      );

    const outcomes = outcomeRows
      .map((row) => ({
        outcomeReceiptId: rowText(row.id, "outcome receipt id", MAX_REFERENCE_LENGTH),
        effectIntentId: rowText(row.effectIntentId, "effect intent id", MAX_REFERENCE_LENGTH),
        attempt:
          Number.isInteger(row.attempt) && row.attempt >= 0
            ? row.attempt
            : (() => {
                throw new GoalReflectionError(
                  GOAL_REFLECTION_INVALID_ROW,
                  "Goal reflection row has invalid attempt",
                );
              })(),
        outcome: rowText(row.outcome, "outcome"),
        effectKey: rowText(row.effectKey, "effect key"),
        observedAt: rowTimestamp(row.createdAt, "outcome time"),
        failureCode: failureCode(row.receipt),
      }))
      .sort((left, right) => compareIds(left.outcomeReceiptId, right.outcomeReceiptId));

    const outcomeIds = outcomes.map(({ outcomeReceiptId }) => outcomeReceiptId);
    const economicRows =
      outcomeIds.length === 0
        ? []
        : await tx
            .select({
              id: economicReceiptsTable.id,
              outcomeReceiptId: economicReceiptsTable.outcomeReceiptId,
              kind: economicReceiptsTable.kind,
              amountMinor: economicReceiptsTable.amountMinor,
              amountAtomic: economicReceiptsTable.amountAtomic,
              amountDecimals: economicReceiptsTable.amountDecimals,
              currency: economicReceiptsTable.currency,
              verificationStatus: economicReceiptsTable.verificationStatus,
              occurredAt: economicReceiptsTable.occurredAt,
            })
            .from(economicReceiptsTable)
            .where(
              and(
                tenantScope(economicReceiptsTable, scope),
                inArray(economicReceiptsTable.outcomeReceiptId, outcomeIds),
              ),
            );

    const economics = economicRows
      .map((row) => ({
        economicReceiptId: rowText(row.id, "economic receipt id", MAX_REFERENCE_LENGTH),
        outcomeReceiptId: rowText(
          row.outcomeReceiptId,
          "economic outcome receipt id",
          MAX_REFERENCE_LENGTH,
        ),
        kind: rowText(row.kind, "economic kind"),
        amountMinor: row.amountMinor,
        amountAtomic: row.amountAtomic,
        amountDecimals: row.amountDecimals,
        currency: rowText(row.currency, "currency", 3),
        verificationStatus: rowText(row.verificationStatus, "verification status"),
        occurredAt: rowTimestamp(row.occurredAt, "economic time"),
      }))
      .sort((left, right) => compareIds(left.economicReceiptId, right.economicReceiptId));

    return deepFreeze({ goalRef, outcomes, economics });
  });
}
