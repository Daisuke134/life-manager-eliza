import { isAbsolute } from "node:path";

export type ProviderToolRef = string;
export type ProviderInputRef = string;

export interface ProviderBridgeRequest {
  toolRef: ProviderToolRef;
  inputRef: ProviderInputRef;
}

export interface ProviderToolDescriptor {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface ProviderProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type ProviderBridgeResult =
  | {
      ok: true;
      status: "succeeded";
      toolRef: ProviderToolRef;
      inputRef: ProviderInputRef;
      exitCode: 0;
      result: Record<string, unknown>;
      resultSha256: string;
    }
  | {
      ok: false;
      status: "failed";
      toolRef: ProviderToolRef;
      inputRef: ProviderInputRef;
      exitCode: number | null;
      errorCode:
        | "PROVIDER_TOOL_FAILED"
        | "PROVIDER_TOOL_OUTPUT_INVALID"
        | "PROVIDER_TOOL_TIMEOUT";
    };

export interface ProviderBridgeDependencies {
  resolve: (
    request: ProviderBridgeRequest,
  ) => Promise<ProviderToolDescriptor>;
  run: (
    descriptor: ProviderToolDescriptor,
  ) => Promise<ProviderProcessResult>;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    CONTROL.test(value)
  ) {
    throw new Error("Provider bridge descriptor invalid");
  }
  return value;
}

function opaqueRequest(request: ProviderBridgeRequest): ProviderBridgeRequest {
  return Object.freeze({
    toolRef: boundedText(request?.toolRef, 512),
    inputRef: boundedText(request?.inputRef, 512),
  });
}

function privateDescriptor(value: ProviderToolDescriptor): ProviderToolDescriptor {
  const executable = boundedText(value?.executable, 1_024);
  const cwd = boundedText(value?.cwd, 4_096);
  if (!isAbsolute(cwd) || !Array.isArray(value?.args) || value.args.length > 64) {
    throw new Error("Provider bridge descriptor invalid");
  }
  const args = value.args.map((arg) => boundedText(arg, 4_096));
  if (
    !value.env ||
    typeof value.env !== "object" ||
    Array.isArray(value.env) ||
    Object.keys(value.env).length > 64 ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > 300_000 ||
    !Number.isInteger(value.maxBufferBytes) ||
    value.maxBufferBytes < 1 ||
    value.maxBufferBytes > 16 * 1024 * 1024
  ) {
    throw new Error("Provider bridge descriptor invalid");
  }
  const env = Object.fromEntries(
    Object.entries(value.env).map(([key, item]) => [
      boundedText(key, 128),
      boundedText(item, 8_192),
    ]),
  );
  return Object.freeze({
    executable,
    args: Object.freeze(args),
    cwd,
    env: Object.freeze(env),
    timeoutMs: value.timeoutMs,
    maxBufferBytes: value.maxBufferBytes,
  });
}

async function resolveProviderDescriptor(
  request: ProviderBridgeRequest,
  dependencies: ProviderBridgeDependencies,
): Promise<ProviderToolDescriptor> {
  return privateDescriptor(await dependencies.resolve(opaqueRequest(request)));
}
