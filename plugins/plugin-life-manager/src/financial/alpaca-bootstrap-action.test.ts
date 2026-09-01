/**
 * Verifies that the Alpaca action helper creates and then reuses one ordinary
 * checkpoint row while persisting only redacted bootstrap output.
 */
import type { Task, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { AlpacaBootstrapResult } from "./alpaca-bootstrap.js";
import { advanceAlpacaBootstrapCheckpoint } from "./alpaca-bootstrap-action.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const TASK_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function ready(checkpointRefs: readonly string[]): AlpacaBootstrapResult {
  return {
    phase: "READY",
    nextAction: "RUN_TRADING_LOOP",
    nextCheckpoint: { phase: "READY", credentialRefs: checkpointRefs },
    facts: {
      credentialRefsBound: checkpointRefs.length,
      verified: true,
      paper: true,
      accountStatus: "ACTIVE",
      cash: 100000,
      equity: 100000,
      optionsLevel: 3,
      positionsCount: 0,
      ordersCount: 0,
      activitiesCount: 0,
    },
  };
}

describe("Alpaca bootstrap checkpoint", () => {
  it("creates one row and reuses it without persisting private values", async () => {
    const tasks: Task[] = [];
    const runtime = {
      agentId: AGENT_ID,
      getTasks: async () => tasks,
      createTask: async (task: Task) => {
        tasks.push({ ...task, id: TASK_ID });
        return TASK_ID;
      },
      updateTask: async (id: UUID, patch: Partial<Task>) => {
        const task = tasks.find((candidate) => candidate.id === id);
        if (!task) throw new Error("missing task");
        Object.assign(task, patch);
      },
    };
    const run = async () => ready(["credential://alpaca/api_key"]);

    await advanceAlpacaBootstrapCheckpoint(runtime, run);
    await advanceAlpacaBootstrapCheckpoint(runtime, run);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.tags).not.toContain("queue");
    expect(tasks[0]?.tags).not.toContain("repeat");
    const persisted = JSON.stringify(tasks[0]);
    expect(persisted).toContain("RUN_TRADING_LOOP");
    expect(persisted).not.toContain("account_id");
    expect(persisted).not.toContain("api_secret");
    expect(persisted).not.toContain("private-value");
  });
});
