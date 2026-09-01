/**
 * Exposes Alpaca bootstrap as a Life Manager action and persists its redacted
 * checkpoint in one ordinary Eliza Task row. The row is not scheduled.
 */
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Task,
  UUID,
} from "@elizaos/core";
import type {
  AlpacaBootstrapAction as AlpacaBootstrapNextAction,
  AlpacaBootstrapCheckpoint,
  AlpacaBootstrapResult,
} from "./alpaca-bootstrap.js";

export const ALPACA_BOOTSTRAP_TASK_NAME =
  "LIFE_MANAGER_ALPACA_BOOTSTRAP_CHECKPOINT" as const;
const TASK_TAGS = ["life-manager", "alpaca", "bootstrap-checkpoint"] as const;
const PHASES = new Set([
  "START",
  "SIGNUP",
  "VERIFY",
  "MFA",
  "API",
  "READY",
  "BLOCKED",
]);

interface CheckpointRuntime {
  readonly agentId: UUID;
  getTasks(params: { tags: string[]; agentIds: UUID[] }): Promise<Task[]>;
  createTask(task: Task): Promise<UUID>;
  updateTask(id: UUID, task: Partial<Task>): Promise<void>;
}

type BootstrapRun = (
  checkpoint: AlpacaBootstrapCheckpoint,
) => Promise<AlpacaBootstrapResult>;

const NEXT_STEP: Record<AlpacaBootstrapNextAction, string> = {
  CREATE_PAPER_ACCOUNT:
    "Use BROWSER to open https://app.alpaca.markets, sign in with the existing normal email/password and TOTP using the private Alpaca bootstrap fill tools, then use Alpaca's account selector to choose Open New Paper Account. Resume the already-open creation page after retries; never create a second account. Keep the default $100,000 balance. Capture the new paper api_key, api_secret, and account_id with ALPACA_BOOTSTRAP_PRIVATE_CAPTURE, then call ALPACA_BOOTSTRAP again. Never use Google login or bypass CAPTCHA, KYC, or legal consent.",
  VERIFY_EMAIL:
    "Call ALPACA_BOOTSTRAP_EMAIL_VERIFY, then call ALPACA_BOOTSTRAP again.",
  CONFIGURE_MFA:
    "Use BROWSER to reach Alpaca MFA setup, ALPACA_BOOTSTRAP_PRIVATE_CAPTURE for totp_secret and recovery_code, ALPACA_BOOTSTRAP_TOTP_FILL to confirm, then call ALPACA_BOOTSTRAP again.",
  BIND_API_KEYS:
    "Use BROWSER to create paper API keys, ALPACA_BOOTSTRAP_PRIVATE_CAPTURE for api_key, api_secret, and account_id, then call ALPACA_BOOTSTRAP again.",
  RETRY_BOOTSTRAP: "Call ALPACA_BOOTSTRAP again without creating a duplicate account.",
  RETRY_CLI_READBACK: "Call ALPACA_BOOTSTRAP again; do not use a REST or SDK fallback.",
  ACCOUNT_OWNER_ACTION:
    "Stop and report the exact provider-required CAPTCHA, KYC, consent, or owner action.",
  RUN_TRADING_LOOP: "Bootstrap is complete; continue through the pinned Alpaca CLI trading loop.",
  STOP: "Stop without performing another account or broker effect.",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCheckpoint(task?: Task): AlpacaBootstrapCheckpoint {
  if (!task) return { phase: "START", credentialRefs: [] };
  const values = record(task.metadata?.values);
  const stored = record(values?.alpacaBootstrap);
  const checkpoint = record(stored?.checkpoint);
  if (
    !checkpoint ||
    typeof checkpoint.phase !== "string" ||
    !PHASES.has(checkpoint.phase) ||
    !Array.isArray(checkpoint.credentialRefs) ||
    !checkpoint.credentialRefs.every((ref) => typeof ref === "string")
  ) {
    throw new Error("Alpaca bootstrap checkpoint is invalid");
  }
  return checkpoint as unknown as AlpacaBootstrapCheckpoint;
}

export async function advanceAlpacaBootstrapCheckpoint(
  runtime: CheckpointRuntime,
  run: BootstrapRun,
): Promise<AlpacaBootstrapResult> {
  const tasks = await runtime.getTasks({
    tags: [...TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  if (tasks.length > 1)
    throw new Error("Duplicate Alpaca bootstrap checkpoints");
  const existing = tasks[0];
  const checkpoint = readCheckpoint(existing);
  const taskId =
    existing?.id ??
    (await runtime.createTask({
      name: ALPACA_BOOTSTRAP_TASK_NAME,
      agentId: runtime.agentId,
      tags: [...TASK_TAGS],
      metadata: { values: { alpacaBootstrap: { checkpoint } } },
    }));
  const result = await run(checkpoint);
  await runtime.updateTask(taskId, {
    metadata: {
      ...existing?.metadata,
      values: {
        ...existing?.metadata?.values,
        alpacaBootstrap: {
          checkpoint: result.nextCheckpoint,
          phase: result.phase,
          nextAction: result.nextAction,
          facts: result.facts,
        },
      },
    },
  });
  return result;
}

export async function setAlpacaBootstrapCheckpointPhase(
  runtime: CheckpointRuntime,
  phase: "SIGNUP" | "VERIFY" | "MFA" | "API",
): Promise<void> {
  const tasks = await runtime.getTasks({
    tags: [...TASK_TAGS],
    agentIds: [runtime.agentId],
  });
  if (tasks.length !== 1 || !tasks[0]?.id) {
    throw new Error("Alpaca bootstrap checkpoint is unavailable");
  }
  const current = readCheckpoint(tasks[0]);
  await runtime.updateTask(tasks[0].id, {
    metadata: {
      ...tasks[0].metadata,
      values: {
        ...tasks[0].metadata?.values,
        alpacaBootstrap: {
          checkpoint: { ...current, phase },
          phase: "BOOTSTRAP_REQUIRED",
          nextAction: {
            SIGNUP: "CREATE_PAPER_ACCOUNT",
            VERIFY: "CONFIGURE_MFA",
            MFA: "CONFIGURE_MFA",
            API: "BIND_API_KEYS",
          }[phase],
        },
      },
    },
  });
}

interface AlpacaBootstrapService {
  runLocalAlpacaBootstrap(
    checkpoint: AlpacaBootstrapCheckpoint,
  ): Promise<AlpacaBootstrapResult>;
}

export const alpacaBootstrapAction: Action = {
  name: "ALPACA_BOOTSTRAP",
  description:
    "Advance or verify the resumable Life Manager-owned Alpaca paper-account bootstrap.",
  descriptionCompressed: "Advance Alpaca paper bootstrap.",
  contexts: ["finance", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime: IAgentRuntime) =>
    runtime.getService("LIFE_MANAGER") !== null,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const service = runtime.getService(
      "LIFE_MANAGER",
    ) as unknown as AlpacaBootstrapService | null;
    if (!service || typeof service.runLocalAlpacaBootstrap !== "function") {
      return { success: false, text: "Life Manager service is unavailable." };
    }
    try {
      const result = await advanceAlpacaBootstrapCheckpoint(
        runtime,
        (checkpoint) => service.runLocalAlpacaBootstrap(checkpoint),
      );
      return {
        success: result.phase !== "BLOCKED",
        text: `Alpaca bootstrap: ${result.phase}; next=${result.nextAction}. ${NEXT_STEP[result.nextAction]}`,
        data: {
          alpacaBootstrap: result,
          nextStep: NEXT_STEP[result.nextAction],
        },
      };
    } catch {
      // error-policy:J1 action boundary returns a redacted failure to the planner.
      return { success: false, text: "Alpaca bootstrap failed safely." };
    }
  },
};
