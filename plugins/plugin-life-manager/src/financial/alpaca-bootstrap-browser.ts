/** Typed browser seam for the active Alpaca bootstrap page. */
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";

interface Parameters {
  readonly operation?: "inspect" | "click" | "fill";
  readonly selector?: string;
  readonly value?: string;
}

interface BrowserServiceShape {
  execute(command: {
    subaction: "inspect" | "realistic-click" | "realistic-fill";
    selector?: string;
    value?: string;
  }): Promise<{
    elements?: Array<{
      ref?: string;
      selector: string;
      tag: string;
      text: string;
      type: string | null;
      name: string | null;
      href: string | null;
      value: null;
    }>;
  }>;
}

function input(options: unknown): Parameters {
  if (!options || typeof options !== "object") return {};
  const parameters = (options as { parameters?: unknown }).parameters;
  return parameters && typeof parameters === "object"
    ? (parameters as Parameters)
    : {};
}

export async function runAlpacaBootstrapBrowser(
  runtime: IAgentRuntime,
  parameters: Parameters,
): Promise<ActionResult> {
  const browser = runtime.getService("browser") as unknown as BrowserServiceShape | null;
  if (!browser) return { success: false, text: "BrowserService is unavailable." };
  if (parameters.operation === "inspect") {
    const result = await browser.execute({ subaction: "inspect" });
    return {
      success: true,
      text: `Inspected ${result.elements?.length ?? 0} safe Alpaca controls.`,
      data: { controls: result.elements ?? [] },
    };
  }
  const selector = parameters.selector?.trim();
  if (!selector || selector.length > 2_048) {
    return { success: false, text: "Alpaca browser parameters are invalid." };
  }
  if (parameters.operation === "fill") {
    if (typeof parameters.value !== "string" || parameters.value.length > 1_000) {
      return { success: false, text: "Alpaca browser fill parameters are invalid." };
    }
    await browser.execute({
      subaction: "realistic-fill",
      selector,
      value: parameters.value,
    });
    return { success: true, text: "Filled the observed Alpaca control." };
  }
  if (parameters.operation !== "click") {
    return { success: false, text: "Alpaca browser parameters are invalid." };
  }
  await browser.execute({ subaction: "realistic-click", selector });
  return { success: true, text: "Clicked the observed Alpaca control." };
}

export const alpacaBootstrapBrowserAction: Action = {
  name: "ALPACA_BOOTSTRAP_BROWSER",
  similes: [
    "INSPECT_ALPACA_BOOTSTRAP",
    "CLICK_ALPACA_BOOTSTRAP",
    "FILL_ALPACA_BOOTSTRAP",
  ],
  description:
    "Inspect safe controls, click, or fill one previously observed selector on the active Alpaca bootstrap page through BrowserService.",
  descriptionCompressed: "Inspect/click/fill active Alpaca bootstrap page.",
  contexts: ["finance", "browser", "automation"],
  routingHint:
    "inspect, click, or fill the active Alpaca signup, dashboard, account menu, MFA, or API-key page while completing Alpaca bootstrap -> ALPACA_BOOTSTRAP_BROWSER",
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      return await runAlpacaBootstrapBrowser(runtime, input(options));
    } catch {
      return { success: false, text: "Alpaca browser action failed safely." };
    }
  },
  parameters: [
    {
      name: "operation",
      description: "Inspect controls, click, or fill an already-observed selector.",
      required: true,
      schema: { type: "string", enum: ["inspect", "click", "fill"] },
    },
    {
      name: "selector",
      description: "Exact selector from the immediately preceding inspect result.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "value",
      description: "Non-secret value for a previously observed input when operation is fill.",
      required: false,
      schema: { type: "string" },
    },
  ],
};
