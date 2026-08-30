import { describe, expect, it } from "vitest";
import {
  executeProviderBridge,
  type ProviderProcessResult,
  type ProviderToolDescriptor,
} from "./provider-bridge.ts";

describe("ProviderBridge", () => {
  it("maps opaque refs to a bounded structured result without exposing process details", async () => {
    const descriptor: ProviderToolDescriptor = {
      executable: "/private/bin/python3",
      args: ["/private/provider/status.py", "discovery", "--json"],
      cwd: "/private/provider",
      env: { PATH: "/usr/bin", PRIVATE_TOKEN: "secret-value" },
      timeoutMs: 1_000,
      maxBufferBytes: 4_096,
    };
    let processResult: ProviderProcessResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"ok":true,"count":2}\n',
      stderr: "",
    };
    const calls: ProviderToolDescriptor[] = [];
    const dependencies = {
      resolve: async () => descriptor,
      run: async (resolved: ProviderToolDescriptor) => {
        calls.push(resolved);
        return processResult;
      },
    };
    const request = { toolRef: "tool-ref-opaque", inputRef: "input-ref-opaque" };

    const success = await executeProviderBridge(request, dependencies);
    expect(calls).toEqual([descriptor]);
    expect(success).toMatchObject({
      ok: true,
      status: "succeeded",
      toolRef: request.toolRef,
      inputRef: request.inputRef,
      exitCode: 0,
      result: { ok: true, count: 2 },
    });
    expect(success.resultSha256).toMatch(/^[0-9a-f]{64}$/);

    processResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"provider":"luma","inventory_complete":true}\n',
      stderr: "",
    };
    await expect(executeProviderBridge(request, dependencies)).resolves.toMatchObject({
      ok: true,
      status: "succeeded",
      result: { provider: "luma", inventory_complete: true },
    });

    processResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "private failure secret-value",
    };
    const failure = await executeProviderBridge(request, dependencies);
    expect(failure).toEqual({
      ok: false,
      status: "failed",
      toolRef: request.toolRef,
      inputRef: request.inputRef,
      exitCode: 1,
      errorCode: "PROVIDER_TOOL_FAILED",
    });

    processResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"ok":true}\n{"extra":true}\n',
      stderr: "",
    };
    const invalid = await executeProviderBridge(request, dependencies);
    expect(invalid).toEqual({
      ok: false,
      status: "failed",
      toolRef: request.toolRef,
      inputRef: request.inputRef,
      exitCode: 0,
      errorCode: "PROVIDER_TOOL_OUTPUT_INVALID",
    });
    expect(JSON.stringify([success, failure, invalid])).not.toMatch(
      /private|secret-value|executable|stdout|stderr|args|cwd|env/,
    );
  });
});
