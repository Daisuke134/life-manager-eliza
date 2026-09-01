/**
 * Captures MFA/API material from BrowserService directly into the private SSOT
 * and fills TOTP codes without exposing either value to the model.
 */
import { createHmac } from "node:crypto";
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import {
  type AlpacaCapturedCredentialField,
  type AlpacaLocalAdapterOptions,
  createLocalAlpacaBootstrapDependencies,
  storeLocalAlpacaCredential,
} from "./alpaca-local-adapter.js";

interface BrowserShape {
  execute(command: Record<string, unknown>, target?: string): Promise<unknown>;
}
interface CaptureInput {
  readonly field?: AlpacaCapturedCredentialField;
  readonly selector?: string;
  readonly getMode?: "attr" | "text" | "value";
  readonly attribute?: string;
  readonly target?: string;
}
interface FillInput {
  readonly selector?: string;
  readonly target?: string;
}

function browser(runtime: IAgentRuntime): BrowserShape {
  const service = runtime.getService("browser") as unknown as BrowserShape | null;
  if (!service || typeof service.execute !== "function") {
    throw new Error("BrowserService is unavailable");
  }
  return service;
}

function extractedValue(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("Browser read is invalid");
  const value = (result as { value?: unknown }).value;
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error("Browser read contains no bounded value");
  }
  return value;
}

function normalizeCaptured(
  field: AlpacaCapturedCredentialField,
  raw: string,
): string {
  let value = raw.trim();
  if (field === "totp_secret" && value.startsWith("otpauth://")) {
    value = new URL(value).searchParams.get("secret") ?? "";
  }
  if (field === "totp_secret") {
    value = value.replace(/[\s-]/gu, "").toUpperCase();
    if (!/^[A-Z2-7]{16,128}$/u.test(value)) {
      throw new Error("TOTP secret is invalid");
    }
  } else if (!value || value.length > 8192) {
    throw new Error("Captured credential is invalid");
  }
  return value;
}

export async function captureAlpacaPrivateCredential(
  runtime: IAgentRuntime,
  input: CaptureInput,
  adapterOptions: AlpacaLocalAdapterOptions = {},
): Promise<ActionResult> {
  if (
    !input.field ||
    !["totp_secret", "recovery_code", "api_key", "api_secret", "account_id"].includes(
      input.field,
    ) ||
    typeof input.selector !== "string" ||
    input.selector.trim().length === 0 ||
    !input.getMode
  ) {
    return { success: false, text: "Alpaca private-capture parameters are invalid." };
  }
  const result = await browser(runtime).execute(
    {
      subaction: "get",
      selector: input.selector.trim(),
      getMode: input.getMode,
      ...(input.attribute ? { attribute: input.attribute } : {}),
    },
    input.target?.trim() || undefined,
  );
  const value = normalizeCaptured(input.field, extractedValue(result));
  storeLocalAlpacaCredential(input.field, value, adapterOptions);
  return {
    success: true,
    text: `Alpaca private ${input.field} captured into the credential SSOT.`,
    data: { field: input.field, stored: true },
  };
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP secret is invalid");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secret: string, nowMs: number): string {
  const counter = Math.floor(nowMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

export async function fillAlpacaTotp(
  runtime: IAgentRuntime,
  input: FillInput,
  adapterOptions: AlpacaLocalAdapterOptions = {},
  nowMs = Date.now(),
): Promise<ActionResult> {
  if (typeof input.selector !== "string" || input.selector.trim().length === 0) {
    return { success: false, text: "Alpaca TOTP-fill parameters are invalid." };
  }
  const dependencies = createLocalAlpacaBootstrapDependencies(adapterOptions);
  const resolved = await dependencies.resolveCredentialRefs(
    dependencies.requiredCredentialRefs,
  );
  const handle = resolved.privateHandle as Record<string, unknown> | undefined;
  if (typeof handle?.totp_secret !== "string") {
    return { success: false, text: "Alpaca TOTP secret is unavailable." };
  }
  const code = totp(handle.totp_secret, nowMs);
  await browser(runtime).execute(
    {
      subaction: "realistic-fill",
      selector: input.selector.trim(),
      value: code,
      replace: true,
    },
    input.target?.trim() || undefined,
  );
  return {
    success: true,
    text: "Current Alpaca TOTP code filled through BrowserService.",
    data: { filled: true },
  };
}

function parameters<T>(options: unknown): T {
  return ((options as { parameters?: unknown } | undefined)?.parameters ?? {}) as T;
}

export const alpacaBootstrapPrivateCaptureAction: Action = {
  name: "ALPACA_BOOTSTRAP_PRIVATE_CAPTURE",
  description:
    "Capture an Alpaca TOTP/API/recovery/account value from BrowserService directly into the private SSOT.",
  descriptionCompressed: "Privately capture Alpaca setup material.",
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      return await captureAlpacaPrivateCredential(
        runtime,
        parameters<CaptureInput>(options),
      );
    } catch {
      // error-policy:J1 browser/credential boundary returns a redacted failure.
      return { success: false, text: "Alpaca private capture failed safely." };
    }
  },
  parameters: [
    {
      name: "field",
      description: "Private value kind; never provide the value itself.",
      required: true,
      schema: {
        type: "string",
        enum: ["totp_secret", "recovery_code", "api_key", "api_secret", "account_id"],
      },
    },
    {
      name: "selector",
      description: "Selector containing the private value.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "getMode",
      description: "BrowserService read mode.",
      required: true,
      schema: { type: "string", enum: ["attr", "text", "value"] },
    },
    {
      name: "attribute",
      description: "Attribute name when getMode=attr.",
      required: false,
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

export const alpacaBootstrapTotpFillAction: Action = {
  name: "ALPACA_BOOTSTRAP_TOTP_FILL",
  description: "Generate the current Alpaca MFA code privately and fill it through BrowserService.",
  descriptionCompressed: "Privately fill Alpaca TOTP.",
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      return await fillAlpacaTotp(runtime, parameters<FillInput>(options));
    } catch {
      // error-policy:J1 TOTP/browser boundary returns a redacted failure.
      return { success: false, text: "Alpaca TOTP fill failed safely." };
    }
  },
  parameters: [
    {
      name: "selector",
      description: "Selector for the current Alpaca MFA code field.",
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
