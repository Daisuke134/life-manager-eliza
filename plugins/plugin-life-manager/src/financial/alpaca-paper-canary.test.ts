import { describe, expect, it, vi } from "vitest";
import type { AlpacaCliProvider, AlpacaPaperOrderReadback } from "./alpaca-local-adapter.js";
import { runAlpacaPaperCanary, sealAlpacaPaperCanary } from "./alpaca-paper-canary.js";

const request = {
  workItemRef: "life-manager-work-item://a08",
  decisionReceiptRef: "life-manager-decision://a08",
  riskReceiptRef: "life-manager-risk://a08",
  risk: { allowed: true, calculatedMaxLossUsd: 113, reasons: [] },
  order: {
    paper: true as const,
    quantity: 1,
    limitPrice: 1.13,
    legs: [
      { symbol: "SPY260908C00770000", ratioQuantity: 1, positionIntent: "buy_to_open" as const },
      { symbol: "SPY260908C00771000", ratioQuantity: 1, positionIntent: "sell_to_open" as const },
    ],
  },
};

describe("Alpaca exactly-once paper canary", () => {
  it("submits once, reads the official order, and submits zero times on replay", async () => {
    const intent = sealAlpacaPaperCanary(request);
    let stored: AlpacaPaperOrderReadback | undefined;
    const submit = vi.fn(async () => {
      stored = {
        paper: true, id: "official-order-1", clientOrderId: intent.clientOrderId,
        status: "accepted", submittedAt: "2026-09-01T18:55:00Z", filledQuantity: 0,
      };
      return stored;
    });
    const provider = {
      findOrderByClientId: vi.fn(async () => stored),
      submitDefinedRiskOrder: submit,
    } as unknown as AlpacaCliProvider;

    const first = await runAlpacaPaperCanary(request, provider);
    const replay = await runAlpacaPaperCanary(request, provider);

    expect(first).toMatchObject({ effect_started: true, replayed: false, receipt: { outcome: "applied" } });
    expect(replay).toMatchObject({ effect_started: false, replayed: true, receipt: { outcome: "noop" } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(intent.clientOrderId).toMatch(/^lm-a08-[a-f0-9]{40}$/);
  });
});
