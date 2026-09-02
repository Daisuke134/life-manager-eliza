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
  readonly assetClass: "NONE" | "CRYPTO" | "EQUITY" | "OPTION";
  readonly candidateRef: string;
  readonly thesis: string;
  readonly structure: string;
  readonly maxLossUsd: number;
  readonly estimatedWinProbability?: number;
  readonly expectedGainUsd?: number;
  readonly expectedValueUsd?: number;
  readonly invalidation: string;
  readonly exitPlan: string;
  readonly evidenceRefs: readonly string[];
  readonly attempts: number;
}

type Database = NodePgDatabase<typeof lifeManagerDbSchema>;
const fields = [
  "status",
  "assetClass",
  "candidateRef",
  "thesis",
  "structure",
  "maxLossUsd",
  "invalidation",
  "exitPlan",
  "evidenceRefs",
] as const;
const legacyFields = fields.filter((field) => field !== "assetClass");
const scoredFields = [
  ...fields,
  "estimatedWinProbability",
  "expectedGainUsd",
] as const;
const persistedScoredFields = [...scoredFields, "expectedValueUsd"] as const;

function assetClassFor(candidateRef: string) {
  if (candidateRef === "NO_TRADE") return "NONE" as const;
  if (candidateRef.startsWith("alpaca-crypto://")) return "CRYPTO" as const;
  if (candidateRef.startsWith("alpaca-equity://")) return "EQUITY" as const;
  if (candidateRef.startsWith("alpaca-option")) return "OPTION" as const;
  throw new Error("Invalid Alpaca trading decision");
}

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
  const legacy = Object.keys(value).length === legacyFields.length &&
    legacyFields.every((field) => Object.hasOwn(value, field));
  const current = Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
  const scored = (Object.keys(value).length === scoredFields.length &&
    scoredFields.every((field) => Object.hasOwn(value, field))) ||
    (Object.keys(value).length === persistedScoredFields.length &&
      persistedScoredFields.every((field) => Object.hasOwn(value, field)));
  if (!legacy && !current && !scored)
    throw new Error("Invalid Alpaca trading decision");
  const inferredAssetClass = assetClassFor(String(value.candidateRef));
  const probability = value.estimatedWinProbability;
  const expectedGain = value.expectedGainUsd;
  const expectedValue = scored && typeof probability === "number" && typeof expectedGain === "number"
    ? Math.round((probability * expectedGain - (1 - probability) * Number(value.maxLossUsd)) * 100) / 100
    : undefined;
  if (
    (value.status !== "NO_TRADE" && value.status !== "TRADE") ||
    (!legacy && value.assetClass !== inferredAssetClass) ||
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
    ) ||
    (scored && (
      typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1 ||
      typeof expectedGain !== "number" || !Number.isFinite(expectedGain) || expectedGain < 0 ||
      (value.status === "NO_TRADE" && (probability !== 0 || expectedGain !== 0)) ||
      (value.status === "TRADE" && (probability <= 0 || expectedGain <= 0)) ||
      (Object.hasOwn(value, "expectedValueUsd") && value.expectedValueUsd !== expectedValue)
    ))
  )
    throw new Error("Invalid Alpaca trading decision");
  return Object.freeze({
    status: value.status,
    assetClass: inferredAssetClass,
    candidateRef: value.candidateRef,
    thesis: value.thesis.trim(),
    structure: value.structure.trim(),
    maxLossUsd: value.maxLossUsd,
    ...(scored ? {
      estimatedWinProbability: probability as number,
      expectedGainUsd: expectedGain as number,
      expectedValueUsd: expectedValue,
    } : {}),
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
    required: [...scoredFields],
    properties: {
      status: { type: "string" as const, enum: ["NO_TRADE", "TRADE"] },
      assetClass: {
        type: "string" as const,
        enum: ["NONE", "CRYPTO", "EQUITY", "OPTION"],
      },
      candidateRef: {
        type: "string" as const,
        enum: ["NO_TRADE", ...request.candidateRefs],
      },
      thesis: { type: "string" as const, maxLength: 2_000 },
      structure: { type: "string" as const, maxLength: 2_000 },
      maxLossUsd: { type: "number" as const, minimum: 0 },
      estimatedWinProbability: { type: "number" as const, minimum: 0, maximum: 1 },
      expectedGainUsd: { type: "number" as const, minimum: 0 },
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
    "Choose at most one offered paper-trading candidate across crypto, equities/ETFs, and options, or choose NO_TRADE.",
    `Return only one JSON object shaped as ${JSON.stringify({ action: ALPACA_TRADING_DECISION, params: Object.fromEntries(scoredFields.map((field) => [field, `<${field}>`])) })}.`,
    "Every thesis, structure, invalidation, and exitPlan string must be non-empty, including for NO_TRADE.",
    "Estimate win probability and expected gain from the offered evidence; do not treat low entry cost as an edge. For NO_TRADE use assetClass NONE, candidateRef NO_TRADE, maxLossUsd 0, estimatedWinProbability 0, and expectedGainUsd 0. For TRADE use the assetClass encoded by exactly one offered candidateRef and its exact offered maxLossUsd. Do not execute or claim profit.",
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
  }).catch(() => ({
    parsed: {
      action: ALPACA_TRADING_DECISION,
      params: {
        status: "NO_TRADE",
        assetClass: "NONE",
        candidateRef: "NO_TRADE",
        thesis: "The decision model was unavailable, so no positive expected value is established.",
        structure: "No paper position is opened.",
        maxLossUsd: 0,
        estimatedWinProbability: 0,
        expectedGainUsd: 0,
        invalidation: "Re-evaluate from fresh market evidence when the decision model is available.",
        exitPlan: "No exit is required because no effect starts.",
        evidenceRefs: [request.evidenceRefs[0]],
      },
    },
    attempts: 2,
  }));
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
