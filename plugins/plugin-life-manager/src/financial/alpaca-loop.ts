/** Runs the single durable Alpaca paper loop and reports each official readback to its owner. */
import { execFile } from "node:child_process";
import type { IAgentRuntime } from "@elizaos/core";
import {
  registerDefaultTaskPack,
  registerScheduledTaskChannelDispatcher,
  registerScheduledTaskRunnerBootHook,
  type ScheduledTaskChannelDispatcherContribution,
  type ScheduledTaskRunnerHandle,
  seedRegisteredTaskPacks,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import {
  closeAlpacaCanaryCampaign,
  rankAlpacaPaperCandidates,
} from "./alpaca-canary-pass.js";
import { createLocalAlpacaCliProvider } from "./alpaca-local-adapter.js";

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

async function reportAlpacaPass(
  ranking: Awaited<ReturnType<typeof rankAlpacaPaperCandidates>>,
  exitStatus: Awaited<ReturnType<typeof closeAlpacaCanaryCampaign>>["status"],
): Promise<string> {
  const target =
    process.env.LM_CONNECTOR_TELEGRAM_TARGET ??
    process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!target) throw new Error("Alpaca Telegram target is unavailable");
  const snapshot = await createLocalAlpacaCliProvider().readCampaignSnapshot();
  const unrealizedPnlUsd = snapshot.positions.reduce(
    (total, position) => total + position.unrealizedPnl,
    0,
  );
  const accountPnlUsd = snapshot.equity - 100_000;
  const decision =
    "decision" in ranking ? ranking.decision.status : ranking.status;
  const effect =
    ranking.status === "SPOT_ORDER_VERIFIED"
      ? "効果: リスク審査済みのペーパー注文を1件送信し、Alpaca CLIで照合済みです。"
      : "効果: 新しい注文は送信していません。";
  const positions = snapshot.positions.length
    ? snapshot.positions
        .map(
          ({ symbol, quantity, unrealizedPnl }) =>
            `${symbol} ${quantity}枚 (${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)})`,
        )
        .join("、")
    : "なし";
  const message = [
    "Life Manager Alpacaペーパーループの5分レポートです。",
    `判断: ${decision}。ゲート結果: ${ranking.status}。SPY決済: ${exitStatus}。`,
    effect,
    `口座資産: $${snapshot.equity.toFixed(2)}、現金: $${snapshot.cash.toFixed(2)}。`,
    `開始時$100,000からの損益: ${accountPnlUsd >= 0 ? "+" : ""}$${accountPnlUsd.toFixed(2)}。`,
    "確定損益: このCLI snapshotだけでは公式確定できません。",
    `含み損益: ${unrealizedPnlUsd >= 0 ? "+" : ""}$${unrealizedPnlUsd.toFixed(2)}。保有: ${positions}。`,
    `観測時刻: ${snapshot.observedAt}（Alpaca CLI公式readback）。`,
  ].join(" ");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "/opt/homebrew/bin/openclaw",
      [
        "message",
        "send",
        "--channel",
        "telegram",
        "--target",
        target,
        "--message",
        message,
        "--json",
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error("Alpaca Telegram receipt is invalid");
  const receipt = JSON.parse(stdout.slice(start, end + 1)) as {
    payload?: { messageId?: unknown };
  };
  const messageId = receipt.payload?.messageId;
  if (typeof messageId !== "string" || !messageId)
    throw new Error("Alpaca Telegram messageId is missing");
  return messageId;
}
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
  const hasLegacyExecutionProfile = task.executionProfile === "bg-light-30s";
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
      const exit = await closeAlpacaCanaryCampaign(runtime, reconciliationPass);
      const ranking = await rankAlpacaPaperCandidates(runtime);
      const telegramMessageId = await reportAlpacaPass(ranking, exit.status);
      return {
        ok: true,
        channelKey: ALPACA_LOOP_CHANNEL,
        metadata: {
          exitStatus: exit.status,
          rankingStatus: ranking.status,
          telegramMessageId,
        },
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
