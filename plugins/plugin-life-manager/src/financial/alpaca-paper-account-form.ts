import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";

interface Parameters {
  readonly field?: "nickname" | "funds";
}

interface BrowserServiceShape {
  execute(command: {
    subaction: "realistic-fill";
    selector: string;
    value: string;
  }): Promise<unknown>;
}

const FIELDS = {
  nickname: { selector: 'input[name="name"]', value: "Life Manager" },
  funds: { selector: 'input[name="cash"]', value: "100000.00" },
} as const;

function parameters(options: unknown): Parameters {
  if (!options || typeof options !== "object") return {};
  const value = (options as { parameters?: unknown }).parameters;
  return value && typeof value === "object" ? (value as Parameters) : {};
}

export async function fillAlpacaPaperAccountForm(
  runtime: IAgentRuntime,
  field: Parameters["field"],
): Promise<ActionResult> {
  if (!field || !(field in FIELDS)) {
    return { success: false, text: "Paper account form field is invalid." };
  }
  const browser = runtime.getService("browser") as unknown as BrowserServiceShape | null;
  if (!browser) return { success: false, text: "BrowserService is unavailable." };
  await browser.execute({ subaction: "realistic-fill", ...FIELDS[field] });
  return {
    success: true,
    text: `Filled the Alpaca paper account ${field} field.`,
    data: { field, filled: true },
  };
}

export const alpacaPaperAccountFormAction: Action = {
  name: "ALPACA_PAPER_ACCOUNT_FORM",
  similes: ["FILL_ALPACA_PAPER_NICKNAME", "FILL_ALPACA_PAPER_FUNDS"],
  description:
    "Fill one field in the open Alpaca New Paper Account form with the fixed Life Manager bootstrap value.",
  descriptionCompressed: "Fill Alpaca paper-account nickname or funds.",
  contexts: ["finance", "browser", "automation"],
  routingHint:
    "fill nickname or $100,000 funds in the open Alpaca New Paper Account dialog -> ALPACA_PAPER_ACCOUNT_FORM",
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      return await fillAlpacaPaperAccountForm(runtime, parameters(options).field);
    } catch {
      return { success: false, text: "Alpaca paper account form fill failed safely." };
    }
  },
  parameters: [
    {
      name: "field",
      description: "The fixed bootstrap field to fill.",
      required: true,
      schema: { type: "string", enum: ["nickname", "funds"] },
    },
  ],
};
