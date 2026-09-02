import { describe, expect, it } from "vitest";
import { buildAlpacaPublicProjection } from "./alpaca-public-projection.js";

describe("Alpaca public projection", () => {
  it("keeps campaign proof while excluding private input data", () => {
    const privateSentinel = "PRIVATE-ACCOUNT-AND-SECRET";
    const projection = buildAlpacaPublicProjection({
      campaign: {
        paper: true, cash: 99_970.95, equity: 99_997.95, lastEquity: 100_000,
        positions: [{ symbol: "SPY260908C00769000", quantity: 1, side: "long", averageEntryPrice: 1, currentPrice: 0.98, marketValue: 98, unrealizedPnl: -2 }],
        fills: [{ id: privateSentinel, orderId: "private-order", symbol: "SPY260908C00769000", side: "buy", quantity: 1, price: 1, transactionAt: "2026-09-01T18:55:00Z" }],
        observedAt: "2026-09-02T06:30:00Z",
      },
      decisions: [{ value: { status: "TRADE", assetClass: "OPTION", candidateRef: "alpaca-option://SPY", thesis: "Bounded edge", maxLossUsd: 29, apiSecret: privateSentinel }, createdAt: new Date("2026-09-01T18:54:00Z") }],
      effects: [{ id: "effect-1", effectClass: "broker.paper.order", status: "applied", createdAt: new Date("2026-09-01T18:55:00Z") }],
      outcomes: [{ effectIntentId: "effect-1", outcome: "applied", receipt: { scoringGate: { allowed: true, reasons: [], private: privateSentinel } }, createdAt: new Date("2026-09-01T18:55:01Z") }],
    });

    expect(projection).toMatchObject({ paper: true, totalPnlUsd: -2.05, unrealizedPnlUsd: -2, latestGate: { allowed: true }, reconciliation: { fillCount: 1 } });
    expect(projection.fills[0]?.id).toMatch(/^public-[a-f0-9]{12}$/);
    expect(JSON.stringify(projection)).not.toContain(privateSentinel);
  });
});
