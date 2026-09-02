import type { IAgentRuntime } from "@elizaos/core";
import {
  registerDefaultTaskPack,
  registerScheduledTaskChannelDispatcher,
  registerScheduledTaskRunnerBootHook,
  seedRegisteredTaskPacks,
  type ScheduledTaskChannelDispatcherContribution,
  type ScheduledTaskRunnerHandle,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { rankAlpacaPaperCandidates } from "./alpaca-canary-pass.js";

export const ALPACA_LOOP_CHANNEL = "life_manager_alpaca_paper_loop";
export const ALPACA_LOOP_IDEMPOTENCY_KEY = "life-manager:alpaca-paper-loop:v1";

const installed = new WeakMap<
  IAgentRuntime,
  ScheduledTaskChannelDispatcherContribution
>();
async function repairAlpacaTaskDispatch(
  runner: ScheduledTaskRunnerHandle,
): Promise<void> {
  const task = (await runner.list()).find(
    ({ idempotencyKey }) => idempotencyKey === ALPACA_LOOP_IDEMPOTENCY_KEY,
  );
  const lastDispatch = task?.metadata?.lastDispatchResult as
    | { reason?: unknown; message?: unknown }
    | undefined;
  if (!task) return;
  const hasLegacyExecutionProfile =
    task.executionProfile === "bg-light-30s";
  const hasDisconnectedDispatcher =
    task.state.status === "scheduled" &&
    lastDispatch?.reason === "disconnected" &&
    typeof lastDispatch.message === "string" &&
    lastDispatch.message.includes(ALPACA_LOOP_CHANNEL);
  if (!hasLegacyExecutionProfile && !hasDisconnectedDispatcher) return;
  const metadata = { ...(task.metadata ?? {}) };
  delete metadata.connectorDegradation;
  delete metadata.escalationCursor;
  delete metadata.lastDispatchError;
  delete metadata.lastDispatchResult;
  delete metadata.pendingDispatch;
  await runner.apply(task.taskId, "edit", {
    metadata,
    ...(hasLegacyExecutionProfile ? { executionProfile: undefined } : {}),
  });
  await runner.fireWithResult(task.taskId, { allowTerminalRefire: true });
}

export function registerAlpacaPaperLoop(runtime: IAgentRuntime): void {
  if (installed.has(runtime)) return;
  const contribution: ScheduledTaskChannelDispatcherContribution = {
    channelKey: ALPACA_LOOP_CHANNEL,
    dispatch: async () => {
      const ranking = await rankAlpacaPaperCandidates(runtime);
      return {
        ok: true,
        channelKey: ALPACA_LOOP_CHANNEL,
        metadata: { rankingStatus: ranking.status },
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
        },
      ],
    });
    registerScheduledTaskRunnerBootHook(runtime, async (service) => {
      const runner = service.getRunner({ agentId: runtime.agentId });
      await seedRegisteredTaskPacks(runtime, runner);
      await repairAlpacaTaskDispatch(runner);
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
