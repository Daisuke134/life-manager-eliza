import type { AlpacaTradingDecision } from "./alpaca-decision.js";

export const ALPACA_RISK_POLICY = Object.freeze({
  maxTradeEquityFraction: 0.005,
  maxOpenRiskEquityFraction: 0.03,
  minCashEquityFraction: 0.3,
  maxDailyLossEquityFraction: 0.015,
  maxDrawdownFraction: 0.04,
  maxPositions: 5,
  maxOpenOrders: 10,
  entryCooldownMs: 5 * 60_000,
  maxQuoteAgeMs: 30_000,
  maxGreeksAgeMs: 60_000,
  maxSpreadFraction: 0.15,
  minDte: 7,
  maxDte: 45,
});

export interface AlpacaRiskGateInput {
  readonly nowMs: number;
  readonly regularSessionOpen: boolean;
  readonly reconciliationHealthy: boolean;
  readonly decision: AlpacaTradingDecision;
  readonly structure: "long_call" | "long_put" | "bull_call_debit_spread" | "bear_put_debit_spread";
  readonly quantity: number;
  readonly netDebitPerShare: number;
  readonly equityUsd: number;
  readonly cashUsd: number;
  readonly highWaterEquityUsd: number;
  readonly dailyPnlUsd: number;
  readonly openMaxLossUsd: number;
  readonly borrowedValueUsd: number;
  readonly optionsLevel: number;
  readonly positionsCount: number;
  readonly openOrdersCount: number;
  readonly quoteBid: number;
  readonly quoteAsk: number;
  readonly quoteAtMs: number;
  readonly greeksAtMs: number;
  readonly dte: number;
  readonly lastEntryAtMs?: number;
}

export interface AlpacaRiskGateResult {
  readonly allowed: boolean;
  readonly calculatedMaxLossUsd: number;
  readonly reasons: readonly string[];
}

export function evaluateAlpacaRisk(input: AlpacaRiskGateInput): AlpacaRiskGateResult {
  const reasons: string[] = [];
  const finite = [
    input.nowMs, input.quantity, input.netDebitPerShare, input.equityUsd, input.cashUsd,
    input.highWaterEquityUsd, input.dailyPnlUsd, input.openMaxLossUsd, input.borrowedValueUsd,
    input.optionsLevel, input.positionsCount, input.openOrdersCount, input.quoteBid, input.quoteAsk,
    input.quoteAtMs, input.greeksAtMs, input.dte,
  ].every(Number.isFinite);
  if (!finite || input.equityUsd <= 0 || input.highWaterEquityUsd <= 0) {
    return Object.freeze({ allowed: false, calculatedMaxLossUsd: 0, reasons: Object.freeze(["INVALID_RISK_INPUT"]) });
  }
  if (input.decision.status === "NO_TRADE") reasons.push("NO_TRADE");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.netDebitPerShare <= 0)
    reasons.push("UNDEFINED_MAX_LOSS");
  const maxLoss = Math.round(input.quantity * input.netDebitPerShare * 100 * 100) / 100;
  if (Math.abs(maxLoss - input.decision.maxLossUsd) > 0.01) reasons.push("MAX_LOSS_MISMATCH");
  if (maxLoss > input.equityUsd * ALPACA_RISK_POLICY.maxTradeEquityFraction)
    reasons.push("TRADE_RISK_LIMIT");
  if (input.openMaxLossUsd + maxLoss > input.equityUsd * ALPACA_RISK_POLICY.maxOpenRiskEquityFraction)
    reasons.push("OPEN_RISK_LIMIT");
  if (input.cashUsd - maxLoss < input.equityUsd * ALPACA_RISK_POLICY.minCashEquityFraction)
    reasons.push("CASH_RESERVE_LIMIT");
  if (input.dailyPnlUsd <= -input.equityUsd * ALPACA_RISK_POLICY.maxDailyLossEquityFraction)
    reasons.push("DAILY_LOSS_HALT");
  if ((input.highWaterEquityUsd - input.equityUsd) / input.highWaterEquityUsd >= ALPACA_RISK_POLICY.maxDrawdownFraction)
    reasons.push("DRAWDOWN_HALT");
  if (input.positionsCount >= ALPACA_RISK_POLICY.maxPositions) reasons.push("POSITION_LIMIT");
  if (input.openOrdersCount >= ALPACA_RISK_POLICY.maxOpenOrders) reasons.push("ORDER_LIMIT");
  if (input.lastEntryAtMs !== undefined && input.nowMs - input.lastEntryAtMs < ALPACA_RISK_POLICY.entryCooldownMs)
    reasons.push("ENTRY_COOLDOWN");
  if (input.nowMs - input.quoteAtMs < 0 || input.nowMs - input.quoteAtMs > ALPACA_RISK_POLICY.maxQuoteAgeMs)
    reasons.push("STALE_QUOTE");
  if (input.nowMs - input.greeksAtMs < 0 || input.nowMs - input.greeksAtMs > ALPACA_RISK_POLICY.maxGreeksAgeMs)
    reasons.push("STALE_GREEKS");
  const mid = (input.quoteAsk + input.quoteBid) / 2;
  if (input.quoteBid < 0 || input.quoteAsk <= input.quoteBid || mid <= 0 || (input.quoteAsk - input.quoteBid) / mid > ALPACA_RISK_POLICY.maxSpreadFraction)
    reasons.push("SPREAD_LIMIT");
  if (!Number.isInteger(input.dte) || input.dte < ALPACA_RISK_POLICY.minDte || input.dte > ALPACA_RISK_POLICY.maxDte)
    reasons.push("DTE_LIMIT");
  const requiredLevel = input.structure.includes("spread") ? 3 : 2;
  if (input.optionsLevel < requiredLevel) reasons.push("OPTIONS_LEVEL");
  if (input.borrowedValueUsd > 0) reasons.push("LEVERAGE_FORBIDDEN");
  if (!input.regularSessionOpen) reasons.push("SESSION_CLOSED");
  if (!input.reconciliationHealthy) reasons.push("RECONCILIATION_UNHEALTHY");
  return Object.freeze({ allowed: reasons.length === 0, calculatedMaxLossUsd: maxLoss, reasons: Object.freeze(reasons) });
}
