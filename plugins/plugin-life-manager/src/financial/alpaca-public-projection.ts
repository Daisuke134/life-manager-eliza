import { createHash } from "node:crypto";
import type { AlpacaCampaignSnapshot } from "./alpaca-local-adapter.js";

type TimedValue = { readonly value: unknown; readonly createdAt: Date };
type EffectValue = {
  readonly id: string;
  readonly effectClass: string;
  readonly status: string;
  readonly createdAt: Date;
};
type OutcomeValue = {
  readonly effectIntentId: string;
  readonly outcome: string;
  readonly receipt: unknown;
  readonly createdAt: Date;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function publicId(value: string): string {
  return `public-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function publicDecision(value: unknown) {
  const item = record(value);
  if (!item) return undefined;
  const keys = ["status", "assetClass", "candidateRef", "thesis", "structure", "maxLossUsd", "estimatedWinProbability", "expectedGainUsd", "expectedValueUsd", "invalidation", "exitPlan"];
  return Object.freeze(Object.fromEntries(keys.flatMap((key) => item[key] === undefined ? [] : [[key, item[key]]])));
}

function publicGate(value: unknown) {
  const receipt = record(value);
  const gate = record(receipt?.scoringGate);
  if (!gate) return undefined;
  const portfolio = record(gate.portfolio);
  return Object.freeze({
    allowed: gate.allowed === true,
    reasons: Array.isArray(gate.reasons) ? gate.reasons.filter((reason): reason is string => typeof reason === "string") : [],
    ...(portfolio ? {
      portfolio: {
        allowed: portfolio.allowed === true,
        aggregateMaxLossUsd: typeof portfolio.aggregateMaxLossUsd === "number" ? portfolio.aggregateMaxLossUsd : undefined,
        reasons: Array.isArray(portfolio.reasons) ? portfolio.reasons.filter((reason): reason is string => typeof reason === "string") : [],
      },
    } : {}),
  });
}

export function buildAlpacaPublicProjection(input: {
  readonly campaign: AlpacaCampaignSnapshot;
  readonly decisions: readonly TimedValue[];
  readonly effects: readonly EffectValue[];
  readonly outcomes: readonly OutcomeValue[];
}) {
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.effectIntentId, outcome]));
  const latestGate = input.outcomes.map(({ receipt }) => publicGate(receipt)).find(Boolean);
  const unrealizedPnlUsd = input.campaign.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  return Object.freeze({
    paper: true as const,
    observedAt: input.campaign.observedAt,
    startingEquityUsd: 100_000,
    equityUsd: input.campaign.equity,
    cashUsd: input.campaign.cash,
    totalPnlUsd: Math.round((input.campaign.equity - 100_000) * 100) / 100,
    dailyPnlUsd: Math.round((input.campaign.equity - input.campaign.lastEquity) * 100) / 100,
    unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
    positions: input.campaign.positions.map(({ symbol, quantity, side, averageEntryPrice, currentPrice, marketValue, unrealizedPnl }) =>
      ({ symbol, quantity, side, averageEntryPrice, currentPrice, marketValue, unrealizedPnl })),
    fills: input.campaign.fills.map(({ id, orderId, symbol, side, quantity, price, transactionAt }) =>
      ({ id: publicId(id), orderId: publicId(orderId), symbol, side, quantity, price, transactionAt })),
    latestDecision: input.decisions[0] ? { ...publicDecision(input.decisions[0].value), createdAt: input.decisions[0].createdAt.toISOString() } : undefined,
    latestGate,
    timeline: input.effects.map((effect) => {
      const outcome = outcomes.get(effect.id);
      return {
        effectClass: effect.effectClass,
        status: effect.status,
        createdAt: effect.createdAt.toISOString(),
        ...(outcome ? { outcome: outcome.outcome, observedAt: outcome.createdAt.toISOString() } : {}),
      };
    }),
    reconciliation: {
      status: "OFFICIAL_CLI_READBACK" as const,
      positionCount: input.campaign.positions.length,
      fillCount: input.campaign.fills.length,
    },
  });
}
