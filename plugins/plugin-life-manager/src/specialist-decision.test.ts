import { ModelType, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { decideSpecialistStep } from "./specialist-decision.js";

const request = Object.freeze({
  workItemRef: "life-manager-work-item://opaque-work-1",
  objective: "Choose the next profitable remote-work action.",
  candidates: Object.freeze([
    Object.freeze({
      candidateRef: "life-manager-candidate://candidate-a",
      summary: "A paid remote software task matching the available capability.",
    }),
    Object.freeze({
      candidateRef: "life-manager-candidate://candidate-b",
      summary: "A paid remote writing task with a near deadline.",
    }),
  ]),
  tools: Object.freeze([
    Object.freeze({
      toolRef: "life-manager-tool://marketplace-read",
      description: "Read structured marketplace state without changing it.",
    }),
    Object.freeze({
      toolRef: "life-manager-tool://application-intent",
      description: "Prepare an authorized application intent without sending it.",
    }),
  ]),
});

function modelResult(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    action: "LIFE_MANAGER_SPECIALIST_DECISION",
    params: {
      candidateRef: "life-manager-candidate://candidate-a",
      toolRef: "life-manager-tool://marketplace-read",
      nextGraph: JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "inspect-candidate",
            toolRef: "life-manager-tool://marketplace-read",
            inputRefs: ["life-manager-candidate://candidate-a"],
          },
        ],
        edges: [],
      }),
      ...overrides,
    },
  });
}

function runtimeReturning(...responses: string[]) {
  const useModel = vi.fn(async () => responses.shift() ?? responses.at(-1) ?? "");
  return {
    runtime: { useModel } as unknown as IAgentRuntime,
    useModel,
  };
}

describe("effect-free specialist decision", () => {
  it("lets ACTION_PLANNER choose one offered candidate, tool, and next graph", async () => {
    const { runtime, useModel } = runtimeReturning(modelResult());

    const result = await decideSpecialistStep(runtime, request);

    expect(result).toEqual({
      candidateRef: "life-manager-candidate://candidate-a",
      toolRef: "life-manager-tool://marketplace-read",
      nextGraph: {
        version: 1,
        nodes: [
          {
            id: "inspect-candidate",
            toolRef: "life-manager-tool://marketplace-read",
            inputRefs: ["life-manager-candidate://candidate-a"],
          },
        ],
        edges: [],
      },
      attempts: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nextGraph)).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.ACTION_PLANNER);
    expect(useModel.mock.calls[0]?.[1]).toMatchObject({
      toolChoice: "required",
      tools: [
        expect.objectContaining({ name: "LIFE_MANAGER_SPECIALIST_DECISION" }),
      ],
    });
  });

  it("rejects refs that were not offered after the bounded reroll", async () => {
    const invalid = modelResult({
      candidateRef: "life-manager-candidate://not-offered",
    });
    const { runtime, useModel } = runtimeReturning(invalid, invalid);

    await expect(decideSpecialistStep(runtime, request)).rejects.toThrow();
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("rejects private or additional graph fields without executing anything", async () => {
    const privateGraph = modelResult({
      nextGraph: JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "inspect-candidate",
            toolRef: "life-manager-tool://marketplace-read",
            inputRefs: ["life-manager-candidate://candidate-a"],
            credential: "must-not-pass",
          },
        ],
        edges: [],
        provider: "must-not-pass",
      }),
    });
    const { runtime } = runtimeReturning(privateGraph);

    await expect(decideSpecialistStep(runtime, request)).rejects.toThrow();
  });
});
