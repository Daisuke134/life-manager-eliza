import { readFileSync } from "node:fs";
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  LIFE_MANAGER_SERVICE_TYPE,
  lifeManagerHealthAction,
  lifeManagerHealthProvider,
  lifeManagerPlugin,
} from "./index";

describe("lifeManagerPlugin", () => {
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
