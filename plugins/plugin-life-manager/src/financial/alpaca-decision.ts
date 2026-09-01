import {
  callModelWithValidation,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  decisionReceiptsTable,
  effectIntentsTable,
  lifeManagerDbSchema,
} from "../db/schema.js";

export const ALPACA_TRADING_DECISION = "ALPACA_TRADING_DECISION" as const;

export interface AlpacaDecisionRequest {
  readonly agentId: string;
  readonly entityId: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly observation: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
  readonly candidateRefs: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AlpacaTradingDecision {
  readonly status: "NO_TRADE" | "TRADE";
  readonly candidateRef: string;
  readonly thesis: string;
  readonly structure: string;
  readonly maxLossUsd: number;
  readonly invalidation: string;
  readonly exitPlan: string;
  readonly evidenceRefs: readonly string[];
  readonly attempts: number;
}

type Database = NodePgDatabase<typeof lifeManagerDbSchema>;
const fields = [
  "status",
  "candidateRef",
  "thesis",
  "structure",
  "maxLossUsd",
  "invalidation",
  "exitPlan",
  "evidenceRefs",
] as const;

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2_000
  );
}

function normalize(
  raw: unknown,
  offeredRefs: readonly string[],
  candidateRefs: readonly string[],
  attempts: number,
): AlpacaTradingDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid Alpaca trading decision");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error("Invalid Alpaca trading decision");
  if (
    (value.status !== "NO_TRADE" && value.status !== "TRADE") ||
    typeof value.candidateRef !== "string" ||
    (value.status === "NO_TRADE"
      ? value.candidateRef !== "NO_TRADE"
      : !candidateRefs.includes(value.candidateRef)) ||
    !validText(value.thesis) ||
    !validText(value.structure) ||
    !validText(value.invalidation) ||
    !validText(value.exitPlan) ||
    typeof value.maxLossUsd !== "number" ||
    !Number.isFinite(value.maxLossUsd) ||
    value.maxLossUsd < 0 ||
    (value.status === "NO_TRADE"
      ? value.maxLossUsd !== 0
      : value.maxLossUsd <= 0) ||
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length === 0 ||
    value.evidenceRefs.some(
      (ref) => typeof ref !== "string" || !offeredRefs.includes(ref),
    )
  )
    throw new Error("Invalid Alpaca trading decision");
  return Object.freeze({
    status: value.status,
    candidateRef: value.candidateRef,
    thesis: value.thesis.trim(),
    structure: value.structure.trim(),
    maxLossUsd: value.maxLossUsd,
    invalidation: value.invalidation.trim(),
    exitPlan: value.exitPlan.trim(),
    evidenceRefs: Object.freeze([...new Set(value.evidenceRefs as string[])]),
    attempts,
  });
}

export async function decideAndPersistAlpacaTrade(
  runtime: IAgentRuntime,
  db: Database,
  request: AlpacaDecisionRequest,
): Promise<AlpacaTradingDecision> {
  const existing = await db
    .select()
    .from(decisionReceiptsTable)
    .where(
      and(
        eq(decisionReceiptsTable.agentId, request.agentId),
        eq(decisionReceiptsTable.entityId, request.entityId),
        eq(decisionReceiptsTable.workItemId, request.workItemId),
      ),
    )
    .limit(1);
  if (existing[0])
    return normalize(
      existing[0].decision,
      request.evidenceRefs,
      request.candidateRefs,
      existing[0].modelAttempts,
    );

  const parameters = {
    type: "object" as const,
    additionalProperties: false,
    required: [...fields],
    properties: {
      status: { type: "string" as const, enum: ["NO_TRADE", "TRADE"] },
      candidateRef: {
        type: "string" as const,
        enum: ["NO_TRADE", ...request.candidateRefs],
      },
      thesis: { type: "string" as const, maxLength: 2_000 },
      structure: { type: "string" as const, maxLength: 2_000 },
      maxLossUsd: { type: "number" as const, minimum: 0 },
      invalidation: { type: "string" as const, maxLength: 2_000 },
      exitPlan: { type: "string" as const, maxLength: 2_000 },
      evidenceRefs: {
        type: "array" as const,
        minItems: 1,
        items: { type: "string" as const, enum: [...request.evidenceRefs] },
      },
    },
  };
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["action", "params"],
    properties: {
      action: { type: "string" as const, enum: [ALPACA_TRADING_DECISION] },
      params: parameters,
    },
  };
  const prompt = [
    "Decide whether this paper account should take one defined-risk options trade now.",
    `Return only one JSON object shaped as ${JSON.stringify({ action: ALPACA_TRADING_DECISION, params: Object.fromEntries(fields.map((field) => [field, `<${field}>`])) })}.`,
    "Every thesis, structure, invalidation, and exitPlan string must be non-empty, including for NO_TRADE.",
    "For NO_TRADE use candidateRef NO_TRADE and maxLossUsd 0. For TRADE use exactly one offered candidateRef and its exact offered maxLossUsd. Do not execute or claim profit.",
    `Objective: ${request.objective}`,
    `Observation: ${JSON.stringify(request.observation)}`,
    `Allowed evidence references: ${JSON.stringify(request.evidenceRefs)}`,
    `Allowed candidate references: ${JSON.stringify(request.candidateRefs)}. Use NO_TRADE only with candidateRef NO_TRADE.`,
  ].join("\n");
  const result = await callModelWithValidation(runtime, {
    modelType: ModelType.TEXT_LARGE,
    params: {
      prompt,
      messages: [{ role: "user", content: prompt }],
      voiceOutput: "internal",
      signal: request.signal,
    },
    schema,
    maxRerolls: 1,
    validateBeforeReturn: true,
  });
  const envelope = result.parsed as Record<string, unknown>;
  if (envelope.action !== ALPACA_TRADING_DECISION)
    throw new Error("Invalid Alpaca trading decision");
  const decision = normalize(
    envelope.params,
    request.evidenceRefs,
    request.candidateRefs,
    result.attempts,
  );
  const { attempts, ...decisionPayload } = decision;
  return db.transaction(async (tx) => {
    const effects = await tx
      .select({ id: effectIntentsTable.id })
      .from(effectIntentsTable)
      .where(
        and(
          eq(effectIntentsTable.agentId, request.agentId),
          eq(effectIntentsTable.entityId, request.entityId),
          eq(effectIntentsTable.workItemId, request.workItemId),
        ),
      )
      .limit(1);
    if (effects.length)
      throw new Error("Alpaca decision must precede every effect intent");
    const inserted = await tx
      .insert(decisionReceiptsTable)
      .values({
        agentId: request.agentId,
        entityId: request.entityId,
        workItemId: request.workItemId,
        decision: decisionPayload,
        modelAttempts: attempts,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted[0] ??
      (
        await tx
          .select()
          .from(decisionReceiptsTable)
          .where(
            and(
              eq(decisionReceiptsTable.agentId, request.agentId),
              eq(decisionReceiptsTable.entityId, request.entityId),
              eq(decisionReceiptsTable.workItemId, request.workItemId),
            ),
          )
          .limit(1)
      )[0];
    if (!row) throw new Error("Alpaca decision persistence failed");
    return normalize(
      row.decision,
      request.evidenceRefs,
      request.candidateRefs,
      row.modelAttempts,
    );
  });
}
