import type { IAgentRuntime } from "@elizaos/core";
import {
  registerDefaultTaskPack,
  registerScheduledTaskChannelDispatcher,
  registerScheduledTaskRunnerBootHook,
  seedRegisteredTaskPacks,
  type ScheduledTaskChannelDispatcherContribution,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { runAlpacaCanaryPass } from "./alpaca-canary-pass.js";

export const ALPACA_LOOP_CHANNEL = "life_manager_alpaca_paper_loop";
export const ALPACA_LOOP_IDEMPOTENCY_KEY = "life-manager:alpaca-paper-loop:v1";

const installed = new WeakMap<
  IAgentRuntime,
  ScheduledTaskChannelDispatcherContribution
>();
const reconciliationPass = {
  runRef: "a08-canary-2",
  candidates: [
    {
      candidateRef: "alpaca-option-spread://SPY/2026-09-08/769C-770C",
      structure: "bull_call_debit_spread" as const,
      buySymbol: "SPY260908C00769000",
      sellSymbol: "SPY260908C00770000",
    },
  ],
};

export function registerAlpacaPaperLoop(runtime: IAgentRuntime): void {
  if (installed.has(runtime)) return;
  const contribution: ScheduledTaskChannelDispatcherContribution = {
    channelKey: ALPACA_LOOP_CHANNEL,
    dispatch: async () => {
      const result = await runAlpacaCanaryPass(runtime, reconciliationPass);
      return {
        ok: true,
        channelKey: ALPACA_LOOP_CHANNEL,
        metadata: { status: result.status },
      };
    },
  };
  registerScheduledTaskChannelDispatcher(runtime, contribution);
  try {
    registerDefaultTaskPack(runtime, {
      id: ALPACA_LOOP_IDEMPOTENCY_KEY,
      tasks: [
        {
          kind: "custom",
          promptInstructions:
            "Run one bounded Life Manager Alpaca paper reconciliation pass and persist its official receipt.",
          trigger: { kind: "interval", everyMinutes: 5 },
          priority: "high",
          output: { destination: "channel", target: ALPACA_LOOP_CHANNEL },
          idempotencyKey: ALPACA_LOOP_IDEMPOTENCY_KEY,
          respectsGlobalPause: true,
          source: "plugin",
          createdBy: "@elizaos/plugin-life-manager",
          ownerVisible: false,
          executionProfile: "bg-light-30s",
        },
      ],
    });
    registerScheduledTaskRunnerBootHook(runtime, async (service) => {
      await seedRegisteredTaskPacks(
        runtime,
        service.getRunner({ agentId: runtime.agentId }),
      );
    });
  } catch (error) {
    unregisterScheduledTaskChannelDispatcher(
      runtime,
      ALPACA_LOOP_CHANNEL,
      contribution,
    );
    throw error;
  }
  installed.set(runtime, contribution);
}

export function unregisterAlpacaPaperLoop(runtime: IAgentRuntime): void {
  const contribution = installed.get(runtime);
  if (!contribution) return;
  unregisterScheduledTaskChannelDispatcher(
    runtime,
    ALPACA_LOOP_CHANNEL,
    contribution,
  );
  installed.delete(runtime);
}
