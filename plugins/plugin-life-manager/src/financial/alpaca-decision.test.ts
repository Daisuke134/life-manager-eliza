import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { decisionReceiptsTable } from "../db/schema.js";
import { decideAndPersistAlpacaTrade } from "./alpaca-decision.js";

const request = {
  agentId: "00000000-0000-4000-8000-000000000001",
  entityId: "00000000-0000-4000-8000-000000000002",
  workItemId: "00000000-0000-4000-8000-000000000003",
  objective: "Grow paper capital without undefined loss.",
  observation: { paper: true, symbol: "SPY", equity: 100_000 },
  evidenceRefs: ["alpaca-cli://spy/latest-trade"],
  candidateRefs: ["alpaca-option://spy/call-1"],
} as const;

function database(effectExists = false) {
  const decisions: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === decisionReceiptsTable
              ? decisions
              : effectExists
                ? [{ id: "effect-before-decision" }]
                : [],
        }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (decisions.length) return [];
            const row = { id: "decision-1", ...value };
            decisions.push(row);
            return [row];
          },
        }),
      }),
    }),
    transaction: async (operation: (tx: unknown) => unknown) => operation(db),
  };
  return db;
}

function runtime() {
  const useModel = vi.fn(async () =>
    JSON.stringify({
      action: "ALPACA_TRADING_DECISION",
      params: {
        status: "NO_TRADE",
        assetClass: "NONE",
        candidateRef: "NO_TRADE",
        thesis: "The observation is insufficient for a bounded edge.",
        structure: "No position.",
        maxLossUsd: 0,
        invalidation: "Re-evaluate after fresh option quotes and Greeks.",
        exitPlan: "No exit because no position is opened.",
        evidenceRefs: ["alpaca-cli://spy/latest-trade"],
      },
    }),
  );
  return { value: { useModel } as unknown as IAgentRuntime, useModel };
}

describe("Alpaca decision-before-effect", () => {
  it("persists one model decision, replays it, and fails closed after an effect", async () => {
    const model = runtime();
    const db = database();
    const first = await decideAndPersistAlpacaTrade(
      model.value,
      db as never,
      request,
    );
    const replay = await decideAndPersistAlpacaTrade(
      model.value,
      db as never,
      request,
    );

    expect(first).toMatchObject({ status: "NO_TRADE", maxLossUsd: 0, attempts: 1 });
    expect(replay).toEqual(first);
    expect(model.useModel).toHaveBeenCalledTimes(1);

    await expect(
      decideAndPersistAlpacaTrade(runtime().value, database(true) as never, request),
    ).rejects.toThrow("must precede every effect intent");
  });
});
