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
