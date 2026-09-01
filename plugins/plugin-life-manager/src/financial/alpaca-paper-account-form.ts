import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";

interface Parameters {
  readonly field?:
    | "open_switcher"
    | "open_form"
    | "accept_cookies"
    | "nickname"
    | "funds"
    | "submit";
}

interface BrowserServiceShape {
  execute(command: {
    subaction: "realistic-type" | "realistic-click" | "realistic-press";
    selector: string;
    text?: string;
    key?: string;
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
  const browser = runtime.getService("browser") as unknown as BrowserServiceShape | null;
  if (!browser) return { success: false, text: "BrowserService is unavailable." };
  if (field === "accept_cookies") {
    await browser.execute({
      subaction: "realistic-click",
      selector: "#rcc-confirm-button",
    });
    return {
      success: true,
      text: "Accepted the Alpaca cookie notice.",
      data: { field, accepted: true },
    };
  }
  if (field === "open_switcher" || field === "open_form") {
    await browser.execute({
      subaction: "realistic-click",
      selector:
        field === "open_switcher"
          ? 'button[data-testid="account-switcher-button"]'
          : 'dialog[data-testid="account-switcher-dropdown"] section:nth-of-type(3) button:nth-of-type(1)',
    });
    return {
      success: true,
      text: `Opened the Alpaca paper account ${field === "open_form" ? "form" : "switcher"}.`,
      data: { field, opened: true },
    };
  }
  if (field === "submit") {
    await browser.execute({
      subaction: "realistic-press",
      selector: 'input[name="name"]',
      key: "Enter",
    });
    return {
      success: true,
      text: "Submitted the Alpaca New Paper Account form once.",
      data: { field, submitted: true },
    };
  }
  if (!field || !(field in FIELDS)) {
    return { success: false, text: "Paper account form field is invalid." };
  }
  const input = FIELDS[field];
  await browser.execute({
    subaction: "realistic-type",
    selector: input.selector,
    text: input.value,
  });
  return {
    success: true,
    text: `Filled the Alpaca paper account ${field} field.`,
    data: { field, filled: true },
  };
}

export const alpacaPaperAccountFormAction: Action = {
  name: "ALPACA_PAPER_ACCOUNT_FORM",
  similes: [
    "FILL_ALPACA_PAPER_NICKNAME",
    "FILL_ALPACA_PAPER_FUNDS",
    "SUBMIT_ALPACA_PAPER_ACCOUNT",
    "OPEN_ALPACA_PAPER_ACCOUNT_FORM",
  ],
  description:
    "Open, fill, or submit the Alpaca New Paper Account form once.",
  descriptionCompressed: "Fill or submit Alpaca paper-account form.",
  contexts: ["finance", "browser", "automation"],
  routingHint:
    "open, fill nickname or $100,000 funds, or submit the Alpaca New Paper Account dialog -> ALPACA_PAPER_ACCOUNT_FORM",
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
      description: "The fixed bootstrap field to fill, or submit once.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "open_switcher",
          "open_form",
          "accept_cookies",
          "nickname",
          "funds",
          "submit",
        ],
      },
    },
  ],
};
