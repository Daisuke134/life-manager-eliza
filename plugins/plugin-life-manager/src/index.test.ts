import { readFileSync } from "node:fs";
import { AgentRuntime } from "@elizaos/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  economicReceiptsTable,
  effectIntentsTable,
  goalsTable,
  lifeManagerDbSchema,
  outcomeReceiptsTable,
  planGraphsTable,
  type EconomicReceiptInsert,
  type EconomicReceiptRow,
  type EffectIntentInsert,
  type EffectIntentRow,
  type GoalInsert,
  type GoalRow,
  type OutcomeReceiptInsert,
  type OutcomeReceiptRow,
  type PlanGraphInsert,
  type PlanGraphRow,
  type WorkItemInsert,
  type WorkItemRow,
  workItemsTable,
} from "./db/schema";
import {
  LIFE_MANAGER_SERVICE_TYPE,
  lifeManagerHealthAction,
  lifeManagerHealthProvider,
  lifeManagerPlugin,
} from "./index";

describe("lifeManagerPlugin", () => {
  it("registers the six tenant-scoped Life Manager domain tables", () => {
    const tables = [
      ["goals", goalsTable],
      ["plan_graphs", planGraphsTable],
      ["work_items", workItemsTable],
      ["effect_intents", effectIntentsTable],
      ["outcome_receipts", outcomeReceiptsTable],
      ["economic_receipts", economicReceiptsTable],
    ] as const;

    expect(Object.values(lifeManagerDbSchema)).toEqual(tables.map(([, table]) => table));
    for (const [name, table] of tables) {
      const config = getTableConfig(table);
      expect(config.schema).toBe("life_manager");
      expect(config.name).toBe(name);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["agent_id", "entity_id"]),
      );
    }
    expect(workItemsTable).toHaveProperty("inputRefs");
    expect(effectIntentsTable).toMatchObject({
      inputRefs: expect.anything(),
      effectKey: expect.anything(),
      leaseOwner: expect.anything(),
      leaseExpiresAt: expect.anything(),
    });
    expect(lifeManagerPlugin.schema).toBe(lifeManagerDbSchema);
    expect(getTableConfig(effectIntentsTable).uniqueConstraints.map(({ name }) => name)).toContain(
      "lm_effect_intents_scope_effect_key_unique",
    );
    expect(getTableConfig(outcomeReceiptsTable).uniqueConstraints.map(({ name }) => name)).toContain(
      "lm_outcome_receipts_scope_attempt_unique",
    );
    expect(getTableConfig(economicReceiptsTable).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "lm_economic_receipts_amount_minor",
        "lm_economic_receipts_amount_atomic",
        "lm_economic_receipts_amount_representation",
      ]),
    );

    expectTypeOf<GoalRow>().toBeObject();
    expectTypeOf<GoalInsert>().toBeObject();
    expectTypeOf<PlanGraphRow>().toBeObject();
    expectTypeOf<PlanGraphInsert>().toBeObject();
    expectTypeOf<WorkItemRow>().toBeObject();
    expectTypeOf<WorkItemInsert>().toBeObject();
    expectTypeOf<EffectIntentRow>().toBeObject();
    expectTypeOf<EffectIntentInsert>().toBeObject();
    expectTypeOf<OutcomeReceiptRow>().toBeObject();
    expectTypeOf<OutcomeReceiptInsert>().toBeObject();
    expectTypeOf<EconomicReceiptRow>().toBeObject();
    expectTypeOf<EconomicReceiptInsert>().toBeObject();
  });

  it("registers exactly one plugin/action/provider/service through the host manifest", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await runtime.registerPlugin(lifeManagerPlugin);
    await runtime.registerPlugin(lifeManagerPlugin);

    expect(runtime.plugins.filter((plugin) => plugin.name === lifeManagerPlugin.name)).toHaveLength(1);
    expect(runtime.actions.filter((action) => action.name === lifeManagerHealthAction.name)).toHaveLength(1);
    expect(runtime.providers.filter((provider) => provider.name === lifeManagerHealthProvider.name)).toHaveLength(1);
    expect(runtime.getRegisteredServiceTypes()).toContain(LIFE_MANAGER_SERVICE_TYPE);

    const appPackage = JSON.parse(
      readFileSync(new URL("../../../packages/app/package.json", import.meta.url), "utf8"),
    );
    expect(appPackage.dependencies["@elizaos/plugin-life-manager"]).toBe("workspace:*");
    expect(appPackage.elizaos.app.defaults["life-manager"]).toEqual({
      enabled: true,
      requiredForReady: true,
    });
  });
});
