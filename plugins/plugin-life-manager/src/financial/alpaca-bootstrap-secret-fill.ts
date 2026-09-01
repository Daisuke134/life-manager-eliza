/**
 * Fills Alpaca signup email or password through the existing BrowserService
 * without placing the secret in model-visible action input or output.
 */
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import {
  type AlpacaLocalAdapterOptions,
  createLocalAlpacaBootstrapDependencies,
} from "./alpaca-local-adapter.js";

type SecretField = "email" | "password";
interface FillParameters {
  readonly field?: SecretField;
  readonly selector?: string;
  readonly target?: string;
}
interface BrowserServiceShape {
  execute(
    command: {
      subaction: "realistic-fill";
      selector: string;
      value: string;
      replace: true;
    },
    target?: string,
  ): Promise<unknown>;
}

function parameters(options: unknown): FillParameters {
  if (!options || typeof options !== "object") return {};
  const raw = (options as { parameters?: unknown }).parameters;
  return raw && typeof raw === "object" ? (raw as FillParameters) : {};
}

export async function fillAlpacaBootstrapSecret(
  runtime: IAgentRuntime,
  input: FillParameters,
  adapterOptions: AlpacaLocalAdapterOptions = {},
): Promise<ActionResult> {
  if (
    (input.field !== "email" && input.field !== "password") ||
    typeof input.selector !== "string" ||
    input.selector.trim().length === 0 ||
    input.selector.length > 512
  ) {
    return {
      success: false,
      text: "Alpaca secret-fill parameters are invalid.",
    };
  }
  const browser = runtime.getService(
    "browser",
  ) as unknown as BrowserServiceShape | null;
  if (!browser || typeof browser.execute !== "function") {
    return { success: false, text: "BrowserService is unavailable." };
  }
  const dependencies = createLocalAlpacaBootstrapDependencies(adapterOptions);
  const resolved = await dependencies.resolveCredentialRefs(
    dependencies.requiredCredentialRefs,
  );
  const handle = resolved.privateHandle as Record<string, unknown> | undefined;
  const value = handle?.[input.field];
  if (typeof value !== "string" || value.length === 0) {
    return { success: false, text: `Alpaca ${input.field} is unavailable.` };
  }
  await browser.execute(
    {
      subaction: "realistic-fill",
      selector: input.selector.trim(),
      value,
      replace: true,
    },
    input.target?.trim() || undefined,
  );
  return {
    success: true,
    text: `Alpaca signup ${input.field} filled through BrowserService.`,
    data: { field: input.field, filled: true },
  };
}

export const alpacaBootstrapSecretFillAction: Action = {
  name: "ALPACA_BOOTSTRAP_SECRET_FILL",
  description:
    "Fill the Alpaca signup email or password from the private SSOT through BrowserService; never provide the value.",
  descriptionCompressed: "Privately fill Alpaca signup email/password.",
  contexts: ["finance", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      return await fillAlpacaBootstrapSecret(runtime, parameters(options));
    } catch {
      // error-policy:J1 browser boundary returns a redacted failure to the planner.
      return {
        success: false,
        text: "Alpaca signup secret fill failed safely.",
      };
    }
  },
  parameters: [
    {
      name: "field",
      description: "Private signup field to fill; never pass its value.",
      required: true,
      schema: { type: "string", enum: ["email", "password"] },
    },
    {
      name: "selector",
      description:
        "Selector observed by the model on the current Alpaca signup page.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "target",
      description: "Optional existing BrowserService target id.",
      required: false,
      schema: { type: "string" },
    },
  ],
};
