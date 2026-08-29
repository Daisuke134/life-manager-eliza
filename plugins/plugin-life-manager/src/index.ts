import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type ProviderResult,
  Service,
} from "@elizaos/core";

export const LIFE_MANAGER_SERVICE_TYPE = "LIFE_MANAGER" as const;

export class LifeManagerService extends Service {
  static serviceType = LIFE_MANAGER_SERVICE_TYPE;
  capabilityDescription = "Hosts Life Manager capabilities inside the existing Eliza runtime.";
  static async start(runtime: IAgentRuntime): Promise<LifeManagerService> {
    return new LifeManagerService(runtime);
  }
  async stop(): Promise<void> {}
}

export const lifeManagerHealthProvider: Provider = {
  name: "lifeManagerHealth",
  description: "Reports whether the Life Manager plugin is registered in this Eliza runtime.",
  descriptionCompressed: "Life Manager plugin health.",
  dynamic: true,
  get: async (runtime: IAgentRuntime): Promise<ProviderResult> => {
    const registered = runtime.plugins.some((plugin) => plugin.name === "@elizaos/plugin-life-manager");
    return {
      text: registered ? "Life Manager plugin: registered." : "Life Manager plugin: unavailable.",
      values: { lifeManagerRegistered: registered },
    };
  },
};

export const lifeManagerHealthAction: Action = {
  name: "LIFE_MANAGER_HEALTH",
  description: "Read the structural registration health of the Life Manager plugin.",
  descriptionCompressed: "Read Life Manager plugin health.",
  validate: async () => true,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const registered = runtime.plugins.some((plugin) => plugin.name === "@elizaos/plugin-life-manager");
    return {
      success: registered,
      text: registered ? "Life Manager plugin is registered." : "Life Manager plugin is unavailable.",
      data: { lifeManagerRegistered: registered },
    };
  },
};

export const lifeManagerPlugin: Plugin = {
  name: "@elizaos/plugin-life-manager",
  description: "Life Manager general-agent capabilities hosted by the existing Eliza runtime.",
  services: [LifeManagerService],
  actions: [lifeManagerHealthAction],
  providers: [lifeManagerHealthProvider],
};

export default lifeManagerPlugin;
