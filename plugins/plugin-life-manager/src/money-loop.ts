import type { IAgentRuntime } from "@elizaos/core";
import {
  registerDefaultTaskPack,
  registerScheduledTaskChannelDispatcher,
  registerScheduledTaskRunnerBootHook,
  seedRegisteredTaskPacks,
  type ScheduledTaskChannelDispatcherContribution,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { decideSpecialistStep } from "./specialist-decision.js";

export const MONEY_LOOP_CHANNEL = "life_manager_general_money_loop";
export const MONEY_LOOP_IDEMPOTENCY_KEY = "life-manager:general-money-loop:v1";

const installed = new WeakMap<
  IAgentRuntime,
  ScheduledTaskChannelDispatcherContribution
>();

export function registerMoneyLoop(runtime: IAgentRuntime): void {
  if (installed.has(runtime)) return;
  const contribution: ScheduledTaskChannelDispatcherContribution = {
    channelKey: MONEY_LOOP_CHANNEL,
    dispatch: async (record) => {
      const decision = await decideSpecialistStep(runtime, {
        workItemRef: `money-wake:${record.taskId}:${record.firedAtIso}`,
        objective:
          "Advance the active economic child goal toward verified banked net while respecting authorization, provider rules, risk, and delivery capacity.",
        candidates: [
          {
            candidateRef: "active-economic-child-goal",
            summary:
              "The highest-positive-EV authorized child goal available from durable Life Manager state.",
          },
        ],
        tools: [
          {
            toolRef: "general-browser:observe-market",
            description:
              "Observe the authenticated live marketplace with the existing general browser; do not create an external effect in this wake.",
          },
        ],
      });
      return {
        ok: true,
        channelKey: MONEY_LOOP_CHANNEL,
        metadata: {
          heartbeatAt: new Date().toISOString(),
          candidateRef: decision.candidateRef,
          toolRef: decision.toolRef,
          nextGraph: decision.nextGraph,
          modelAttempts: decision.attempts,
        },
      };
    },
  };

  registerScheduledTaskChannelDispatcher(runtime, contribution);
  try {
    registerDefaultTaskPack(runtime, {
      id: MONEY_LOOP_IDEMPOTENCY_KEY,
      tasks: [
        {
          kind: "custom",
          promptInstructions:
            "Run one bounded General Agent money wake from the active durable Goal and checkpoint.",
          trigger: { kind: "interval", everyMinutes: 5 },
          priority: "high",
          output: { destination: "channel", target: MONEY_LOOP_CHANNEL },
          idempotencyKey: MONEY_LOOP_IDEMPOTENCY_KEY,
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
      MONEY_LOOP_CHANNEL,
      contribution,
    );
    throw error;
  }
  installed.set(runtime, contribution);
}

export function unregisterMoneyLoop(runtime: IAgentRuntime): void {
  const contribution = installed.get(runtime);
  if (!contribution) return;
  unregisterScheduledTaskChannelDispatcher(
    runtime,
    MONEY_LOOP_CHANNEL,
    contribution,
  );
  installed.delete(runtime);
}
