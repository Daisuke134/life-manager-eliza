import {
  type Action,
  type ActionResult,
  type AuthorizedCapabilityRequest,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type ProviderResult,
  Service,
} from "@elizaos/core";
import {
  authorizeLifeManagerCapability as authorizeCapability,
  type LifeManagerAuthorizationResolver,
} from "./capability-authorization.js";
import { lifeManagerDbSchema } from "./db/schema.js";
import {
  type EffectReceiptKernelDependencies,
  type EffectReceiptKernelRequest,
  type EffectReceiptKernelResult,
  runEffectReceiptKernel as runEffectReceiptKernelOperation,
} from "./effect-receipt-kernel.js";
import {
  type AlpacaBootstrapCheckpoint,
  type AlpacaBootstrapDependencies,
  type AlpacaBootstrapResult,
  runAlpacaBootstrap as runAlpacaBootstrapOperation,
} from "./financial/alpaca-bootstrap.js";
import { alpacaBootstrapAction } from "./financial/alpaca-bootstrap-action.js";
import { alpacaBootstrapEmailVerifyAction } from "./financial/alpaca-bootstrap-email-verify.js";
import { alpacaBootstrapSecretFillAction } from "./financial/alpaca-bootstrap-secret-fill.js";
import {
  type AlpacaLocalAdapterOptions,
  createLocalAlpacaBootstrapDependencies,
} from "./financial/alpaca-local-adapter.js";
import {
  type GoalReflection,
  type GoalReflectionDatabase,
  type GoalReflectionReadInput,
  readGoalReflection,
} from "./goal-reflection.js";
import {
  type GoalWorkItemDatabase,
  type GoalWorkItemPersistenceInput,
  type GoalWorkItemResult,
  persistGoalWorkItem as persistGoalWorkItemRows,
} from "./goal-work-item.js";
import { LifeManagerMigrationService } from "./services/migration.js";
import { ProviderBridgeService } from "./services/provider-bridge.js";
import {
  decideSpecialistStep as decideSpecialistStepOperation,
  type SpecialistDecision,
  type SpecialistDecisionRequest,
} from "./specialist-decision.js";

export const LIFE_MANAGER_SERVICE_TYPE = "LIFE_MANAGER" as const;

export class LifeManagerService extends Service {
  static serviceType = LIFE_MANAGER_SERVICE_TYPE;
  capabilityDescription =
    "Hosts Life Manager capabilities inside the existing Eliza runtime.";
  static async start(runtime: IAgentRuntime): Promise<LifeManagerService> {
    return new LifeManagerService(runtime);
  }
  async persistGoalWorkItem(
    input: GoalWorkItemPersistenceInput,
  ): Promise<GoalWorkItemResult> {
    const db = this.runtime.db as unknown as GoalWorkItemDatabase | undefined;
    if (!db || typeof db.transaction !== "function") {
      throw new Error(
        "Life Manager Goal WorkItem requires plugin-sql runtime.db",
      );
    }
    return persistGoalWorkItemRows(db, input);
  }
  async authorizeLifeManagerCapability(
    value: unknown,
    dependencies: LifeManagerAuthorizationResolver,
    now?: number,
  ): Promise<AuthorizedCapabilityRequest> {
    return authorizeCapability(value, dependencies, now);
  }
  async decideSpecialistStep(
    request: SpecialistDecisionRequest,
  ): Promise<SpecialistDecision> {
    return decideSpecialistStepOperation(this.runtime, request);
  }
  async runEffectReceiptKernel(
    request: EffectReceiptKernelRequest,
    dependencies: EffectReceiptKernelDependencies,
  ): Promise<EffectReceiptKernelResult> {
    return runEffectReceiptKernelOperation(request, dependencies);
  }
  async runAlpacaBootstrap(
    checkpoint: AlpacaBootstrapCheckpoint,
    dependencies: AlpacaBootstrapDependencies,
  ): Promise<AlpacaBootstrapResult> {
    return runAlpacaBootstrapOperation(checkpoint, dependencies);
  }
  async runLocalAlpacaBootstrap(
    checkpoint: AlpacaBootstrapCheckpoint,
    options: AlpacaLocalAdapterOptions = {},
  ): Promise<AlpacaBootstrapResult> {
    return runAlpacaBootstrapOperation(
      checkpoint,
      createLocalAlpacaBootstrapDependencies(options),
    );
  }
  async reflectGoal(input: GoalReflectionReadInput): Promise<GoalReflection> {
    const db = this.runtime.db as unknown as GoalReflectionDatabase | undefined;
    if (
      !db ||
      typeof db.select !== "function" ||
      typeof db.transaction !== "function"
    ) {
      throw new Error(
        "Life Manager Goal reflection requires plugin-sql runtime.db",
      );
    }
    return readGoalReflection(db, input);
  }
  async stop(): Promise<void> {}
}

export const lifeManagerHealthProvider: Provider = {
  name: "lifeManagerHealth",
  description:
    "Reports whether the Life Manager plugin is registered in this Eliza runtime.",
  descriptionCompressed: "Life Manager plugin health.",
  dynamic: true,
  get: async (runtime: IAgentRuntime): Promise<ProviderResult> => {
    const registered = runtime.plugins.some(
      (plugin) => plugin.name === "@elizaos/plugin-life-manager",
    );
    return {
      text: registered
        ? "Life Manager plugin: registered."
        : "Life Manager plugin: unavailable.",
      values: { lifeManagerRegistered: registered },
    };
  },
};

export const lifeManagerHealthAction: Action = {
  name: "LIFE_MANAGER_HEALTH",
  description:
    "Read the structural registration health of the Life Manager plugin.",
  descriptionCompressed: "Read Life Manager plugin health.",
  validate: async () => true,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const registered = runtime.plugins.some(
      (plugin) => plugin.name === "@elizaos/plugin-life-manager",
    );
    return {
      success: registered,
      text: registered
        ? "Life Manager plugin is registered."
        : "Life Manager plugin is unavailable.",
      data: { lifeManagerRegistered: registered },
    };
  },
};

export const lifeManagerPlugin: Plugin = {
  name: "@elizaos/plugin-life-manager",
  description:
    "Life Manager general-agent capabilities hosted by the existing Eliza runtime.",
  dependencies: ["@elizaos/plugin-sql"],
  services: [
    LifeManagerMigrationService,
    ProviderBridgeService,
    LifeManagerService,
  ],
  actions: [
    lifeManagerHealthAction,
    alpacaBootstrapAction,
    alpacaBootstrapEmailVerifyAction,
    alpacaBootstrapSecretFillAction,
  ],
  providers: [lifeManagerHealthProvider],
  schema: lifeManagerDbSchema,
};

export default lifeManagerPlugin;
