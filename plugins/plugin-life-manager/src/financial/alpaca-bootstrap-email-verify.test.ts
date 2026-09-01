/**
 * Verifies the read-only mail-to-browser handoff with injected boundaries;
 * the verification token reaches BrowserService but not the action result.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeAlpacaEmailVerification } from "./alpaca-bootstrap-email-verify.js";

describe("Alpaca email verification", () => {
  it("opens only the private allowlisted link and advances the checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lm-alpaca-email-"));
    const credentialsPath = join(directory, "credentials.json");
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        credentials: [
          {
            service: "app.alpaca.markets",
            email: "owner@example.invalid",
            password: "private-password",
            paper_endpoint: "https://paper-api.alpaca.markets/v2",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const taskId = "00000000-0000-0000-0000-000000000002" as UUID;
    const tasks: Task[] = [
      {
        id: taskId,
        name: "LIFE_MANAGER_ALPACA_BOOTSTRAP_CHECKPOINT",
        tags: ["life-manager", "alpaca", "bootstrap-checkpoint"],
        metadata: {
          values: {
            alpacaBootstrap: {
              checkpoint: {
                phase: "SIGNUP",
                credentialRefs: ["credential://alpaca/email"],
              },
            },
          },
        },
      },
    ];
    const execute = vi.fn(async () => ({}));
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      getService: (name: string) => (name === "browser" ? { execute } : null),
      getTasks: async () => tasks,
      updateTask: async (_id: UUID, patch: Partial<Task>) => {
        Object.assign(tasks[0] as Task, patch);
      },
    } as unknown as IAgentRuntime;
    const mailCalls: readonly string[][] = [];
    const mutableCalls = mailCalls as string[][];
    const execFile = (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      mutableCalls.push([...args]);
      if (args[0] === "version") return callback(null, "0.17.0 (test)\n");
      if (args.includes("search")) {
        return callback(
          null,
          JSON.stringify([
            {
              id: "message-1",
              subject: "Verify your Alpaca account",
              date: "2026-09-02T00:00:00Z",
            },
          ]),
        );
      }
      return callback(
        null,
        JSON.stringify({
          body: '<a href="https://app.alpaca.markets/verify?token=private-token">Verify</a>',
        }),
      );
    };

    try {
      const result = await executeAlpacaEmailVerification(runtime, {
        credentialsPath,
        gogPath: "/tmp/gog",
        execFile,
        target: "bridge",
      });
      expect(result.success).toBe(true);
      expect(execute).toHaveBeenCalledWith(
        {
          subaction: "open",
          url: "https://app.alpaca.markets/verify?token=private-token",
          show: true,
        },
        "bridge",
      );
      expect(JSON.stringify(result)).not.toContain("private-token");
      expect(JSON.stringify(tasks[0]?.metadata)).toContain('"phase":"VERIFY"');
      expect(mailCalls.every((args) => !args.includes("send"))).toBe(true);
      expect(
        mailCalls.slice(1).every((args) => args.includes("--gmail-no-send")),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
