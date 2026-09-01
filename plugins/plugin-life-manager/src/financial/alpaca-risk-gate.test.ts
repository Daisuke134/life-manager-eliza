import { describe, expect, it } from "vitest";
import { evaluateAlpacaRisk, type AlpacaRiskGateInput } from "./alpaca-risk-gate.js";

const now = Date.parse("2026-09-01T18:00:00Z");
const allowed: AlpacaRiskGateInput = {
  nowMs: now, regularSessionOpen: true, reconciliationHealthy: true,
  decision: { status: "TRADE", candidateRef: "candidate://spread", thesis: "Defined edge", structure: "bull call debit spread", maxLossUsd: 400, invalidation: "Break", exitPlan: "Exit", evidenceRefs: ["cli://quote"], attempts: 1 },
  structure: "bull_call_debit_spread", quantity: 1, netDebitPerShare: 4,
  equityUsd: 100_000, cashUsd: 100_000, highWaterEquityUsd: 100_000,
  dailyPnlUsd: 0, openMaxLossUsd: 0, borrowedValueUsd: 0, optionsLevel: 3,
  positionsCount: 0, openOrdersCount: 0, quoteBid: 3.9, quoteAsk: 4.1,
  quoteAtMs: now - 5_000, greeksAtMs: now - 10_000, dte: 30,
};

describe("Alpaca deterministic risk gate", () => {
  it("permits the bounded proposal and reports every independent halt", () => {
    expect(evaluateAlpacaRisk(allowed)).toEqual({ allowed: true, calculatedMaxLossUsd: 400, reasons: [] });
    const rejected = evaluateAlpacaRisk({
      ...allowed, regularSessionOpen: false, reconciliationHealthy: false,
      optionsLevel: 2, borrowedValueUsd: 1, positionsCount: 5, openOrdersCount: 10,
      dailyPnlUsd: -1_500, highWaterEquityUsd: 105_000, quoteAtMs: now - 31_000,
      greeksAtMs: now - 61_000, quoteBid: 3, quoteAsk: 5, dte: 0, lastEntryAtMs: now - 1_000,
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reasons).toEqual(expect.arrayContaining([
      "DAILY_LOSS_HALT", "DRAWDOWN_HALT", "POSITION_LIMIT", "ORDER_LIMIT", "ENTRY_COOLDOWN",
      "STALE_QUOTE", "STALE_GREEKS", "SPREAD_LIMIT", "DTE_LIMIT", "OPTIONS_LEVEL",
      "LEVERAGE_FORBIDDEN", "SESSION_CLOSED", "RECONCILIATION_UNHEALTHY",
    ]));
    expect(evaluateAlpacaRisk({ ...allowed, structure: "naked_short" } as never).reasons)
      .toEqual(["INVALID_RISK_INPUT"]);
  });
});
