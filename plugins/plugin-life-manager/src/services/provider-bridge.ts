import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";

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

function defaultProviderRunner(
  descriptor: ProviderToolDescriptor,
): Promise<ProviderProcessResult> {
  return new Promise((resolve) => {
    execFile(
      descriptor.executable,
      [...descriptor.args],
      {
        cwd: descriptor.cwd,
        env: { ...descriptor.env },
        timeout: descriptor.timeoutMs,
        maxBuffer: descriptor.maxBufferBytes,
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & {
          code?: number | string;
          signal?: NodeJS.Signals;
          killed?: boolean;
        }) | null;
        resolve({
          exitCode:
            typeof failure?.code === "number"
              ? failure.code
              : failure
                ? null
                : 0,
          signal: failure?.signal ?? null,
          timedOut:
            failure?.code === "ETIMEDOUT" || failure?.killed === true,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function failedResult(
  request: ProviderBridgeRequest,
  exitCode: number | null,
  errorCode:
    | "PROVIDER_TOOL_FAILED"
    | "PROVIDER_TOOL_OUTPUT_INVALID"
    | "PROVIDER_TOOL_TIMEOUT",
): ProviderBridgeResult {
  return Object.freeze({
    ok: false,
    status: "failed",
    toolRef: request.toolRef,
    inputRef: request.inputRef,
    exitCode,
    errorCode,
  });
}

function publicResult(
  request: ProviderBridgeRequest,
  descriptor: ProviderToolDescriptor,
  processResult: ProviderProcessResult,
): ProviderBridgeResult {
  if (processResult.timedOut) {
    return failedResult(request, processResult.exitCode, "PROVIDER_TOOL_TIMEOUT");
  }
  if (
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    Buffer.byteLength(processResult.stdout) > descriptor.maxBufferBytes
  ) {
    return failedResult(request, processResult.exitCode, "PROVIDER_TOOL_FAILED");
  }
  const source = processResult.stdout.endsWith("\n")
    ? processResult.stdout.slice(0, -1)
    : processResult.stdout;
  if (!source || source.includes("\n") || source.includes("\r")) {
    return failedResult(request, 0, "PROVIDER_TOOL_OUTPUT_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return failedResult(request, 0, "PROVIDER_TOOL_OUTPUT_INVALID");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ("ok" in parsed && (parsed as Record<string, unknown>).ok !== true)
  ) {
    return failedResult(request, 0, "PROVIDER_TOOL_OUTPUT_INVALID");
  }
  return Object.freeze({
    ok: true,
    status: "succeeded",
    toolRef: request.toolRef,
    inputRef: request.inputRef,
    exitCode: 0,
    result: parsed as Record<string, unknown>,
    resultSha256: createHash("sha256").update(source).digest("hex"),
  });
}

export async function executeProviderBridge(
  request: ProviderBridgeRequest,
  dependencies: ProviderBridgeDependencies,
): Promise<ProviderBridgeResult> {
  const safeRequest = opaqueRequest(request);
  const descriptor = await resolveProviderDescriptor(safeRequest, dependencies);
  let processResult: ProviderProcessResult;
  try {
    processResult = await dependencies.run(descriptor);
  } catch {
    return failedResult(safeRequest, null, "PROVIDER_TOOL_FAILED");
  }
  return publicResult(safeRequest, descriptor, processResult);
}

export const PROVIDER_BRIDGE_SERVICE_TYPE = "PROVIDER_BRIDGE" as const;

export class ProviderBridgeService extends Service {
  static override readonly serviceType = PROVIDER_BRIDGE_SERVICE_TYPE;
  override capabilityDescription =
    "Executes host-resolved legacy provider tools from opaque refs and returns bounded structured results.";
  private resolver: ProviderBridgeDependencies["resolve"] | null = null;

  static async start(runtime: IAgentRuntime): Promise<ProviderBridgeService> {
    return new ProviderBridgeService(runtime);
  }

  registerResolver(resolver: ProviderBridgeDependencies["resolve"]): void {
    if (this.resolver !== null || typeof resolver !== "function") {
      throw new Error("Provider bridge resolver unavailable");
    }
    this.resolver = resolver;
  }

  async execute(request: ProviderBridgeRequest): Promise<ProviderBridgeResult> {
    if (this.resolver === null) {
      throw new Error("Provider bridge resolver unavailable");
    }
    return executeProviderBridge(request, {
      resolve: this.resolver,
      run: defaultProviderRunner,
    });
  }

  override async stop(): Promise<void> {
    this.resolver = null;
  }
}
