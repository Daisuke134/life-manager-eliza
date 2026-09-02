import {
  ChannelType,
  createMessageMemory,
  type IAgentRuntime,
  logger,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
  registerRuntimeManagedInternalActor,
  stringToUuid,
} from "@elizaos/core";
import {
  registerDefaultTaskPack,
  registerScheduledTaskChannelDispatcher,
  registerScheduledTaskRunnerBootHook,
  seedRegisteredTaskPacks,
  type ScheduledTaskChannelDispatcherContribution,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";

export const MONEY_LOOP_CHANNEL = "life_manager_general_money_loop";
export const MONEY_LOOP_IDEMPOTENCY_KEY = "life-manager:general-money-loop:v1";
const MONEY_LOOP_PROMPT =
  "Advance the active economic child Goal toward verified banked net. Use the authenticated general browser as your eyes and hands: observe the live marketplace, choose every fresh positive-EV opportunity you can truthfully fulfill, and use browser actions yourself to apply. Before submitting, read the provider's official application history and never submit an opportunity already present there. Do not reject work merely because an exact Skill or prior portfolio item is missing. Never invent qualifications, bypass provider rules, duplicate an application, or call a marketplace-specific workflow. Report every opportunity decision separately immediately after deciding it, never only as an aggregate. Use the same shared owner transport as the working marketplace loops by running openclaw message send --channel telegram --target $LM_CONNECTOR_TELEGRAM_TARGET --message <message> --json, and require its provider messageId ACK. Each message must include the official title, opportunity ID, applied or skipped outcome, and a natural-language reason. For every application also include the proposed amount, delivery date, and official provider proposal ID read back after submission. Count success only after official provider readback returns its application receipt. Do not send an aggregate 'no matching opportunities' report in place of the individual decisions. Continue within this bounded wake until no fresh opportunity remains, then preserve the checkpoint for the next wake.";

const installed = new WeakMap<
  IAgentRuntime,
  ScheduledTaskChannelDispatcherContribution
>();

export function registerMoneyLoop(runtime: IAgentRuntime): void {
  if (process.env.LIFE_MANAGER_ENABLE_MONEY_LOOP !== "1") return;
  if (installed.has(runtime)) return;
  logger.info("[life-manager-money-loop] registering");
  const contribution: ScheduledTaskChannelDispatcherContribution = {
    channelKey: MONEY_LOOP_CHANNEL,
    dispatch: async (record) => {
      logger.info(
        { taskId: record.taskId, firedAtIso: record.firedAtIso },
        "[life-manager-money-loop] dispatching",
      );
      const messageService = runtime.messageService;
      if (!messageService) throw new Error("Message service is unavailable");
      const roomId = stringToUuid(`life-manager-money-room:${runtime.agentId}`);
      const entityId = stringToUuid(`life-manager-money-actor:${runtime.agentId}`);
      await runtime.ensureConnection({
        entityId,
        roomId,
        worldId: stringToUuid(`life-manager-money-world:${runtime.agentId}`),
        type: ChannelType.DM,
        name: "Life Manager money loop",
        userName: "life-manager",
        source: MESSAGE_SOURCE_TRIGGER_PROMPT,
      });
      const releaseActor = registerRuntimeManagedInternalActor(runtime, entityId);
      let result;
      try {
        result = await messageService.handleMessage(
          runtime,
          createMessageMemory({
            id: stringToUuid(`life-manager-money:${record.taskId}:${record.firedAtIso}`),
            entityId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: `Scheduled Life Manager money wake fired. Do this now: ${record.promptInstructions}`,
              source: MESSAGE_SOURCE_TRIGGER_PROMPT,
            },
          }),
        );
      } finally {
        releaseActor();
      }
      if (result.terminalFailure) {
        throw new Error(result.terminalFailure.message);
      }
      return {
        ok: true,
        channelKey: MONEY_LOOP_CHANNEL,
        metadata: {
          heartbeatAt: new Date().toISOString(),
          actionCount: result.actionResults?.length ?? 0,
          didRespond: result.didRespond,
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
          promptInstructions: MONEY_LOOP_PROMPT,
          trigger: { kind: "interval", everyMinutes: 1 },
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
      const runner = service.getRunner({ agentId: runtime.agentId });
      await seedRegisteredTaskPacks(
        runtime,
        runner,
      );
      const moneyTask = (await runner.list()).find(
        (task) => task.idempotencyKey === MONEY_LOOP_IDEMPOTENCY_KEY,
      );
      if (moneyTask) {
        await runner.apply(moneyTask.taskId, "edit", {
          promptInstructions: MONEY_LOOP_PROMPT,
          trigger: { kind: "interval", everyMinutes: 1 },
        });
        await runner.apply(moneyTask.taskId, "snooze", {
          untilIso: new Date().toISOString(),
        });
      }
      logger.info(
        { taskId: moneyTask?.taskId ?? null },
        "[life-manager-money-loop] seed complete",
      );
      const taskService = runtime.getService("task") as
        | { runDueTasks?: () => Promise<void>; startTimer?: () => void }
        | null;
      await taskService?.runDueTasks?.();
      taskService?.startTimer?.();
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
