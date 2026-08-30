import { describe, expect, it } from "vitest";
import type { GoalRow } from "./db/schema.ts";
import { buildGoalWorkItemRows } from "./goal-work-item.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_ID = "00000000-0000-4000-8000-000000000002";
const GOAL_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-30T00:00:00.000Z");

function goal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: GOAL_ID,
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    statement: "Earn one externally paid outcome",
    provenance: {
      source: "user_message",
      evidence: "private-message-ref",
      observedAt: "2026-08-29T00:00:00.000Z",
    },
    status: "active",
    expiresAt: null,
    supersedes: null,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Goal to WorkItem contract", () => {
  it("maps one active Goal to one stable reference-only WorkItem without copying private text", () => {
    const first = buildGoalWorkItemRows(goal(), NOW);
    const replay = buildGoalWorkItemRows(goal(), NOW);

    expect(first).toEqual(replay);
    expect(first).toEqual({
      planGraph: {
        id: GOAL_ID,
        agentId: AGENT_ID,
        entityId: ENTITY_ID,
        goalId: GOAL_ID,
        graph: {
          version: 1,
          goal_ref: `life-manager-goal://${AGENT_ID}/${ENTITY_ID}/${GOAL_ID}`,
        },
        status: "reference_only",
      },
      workItem: {
        id: GOAL_ID,
        agentId: AGENT_ID,
        entityId: ENTITY_ID,
        planGraphId: GOAL_ID,
        capability: "general-agent.work",
        inputRefs: {
          goal_ref: `life-manager-goal://${AGENT_ID}/${ENTITY_ID}/${GOAL_ID}`,
        },
        status: "pending",
      },
    });
    expect(JSON.stringify(first)).not.toMatch(
      /externally paid outcome|private-message-ref|user_message/,
    );
    expect(() => buildGoalWorkItemRows(goal({ status: "completed" }), NOW)).toThrow(
      "active Goal",
    );
    expect(() =>
      buildGoalWorkItemRows(goal({ expiresAt: new Date("2026-08-29T00:00:00.000Z") }), NOW),
    ).toThrow("active Goal");
  });
});
