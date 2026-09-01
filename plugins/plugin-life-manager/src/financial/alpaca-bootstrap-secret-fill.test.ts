/**
 * Verifies that browser fill receives the private value while the action result
 * and model-supplied parameters never contain it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { fillAlpacaBootstrapSecret } from "./alpaca-bootstrap-secret-fill.js";

describe("Alpaca bootstrap private fill", () => {
  it("passes only the internally resolved secret to BrowserService", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lm-alpaca-fill-"));
    const credentialsPath = join(directory, "credentials.json");
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        credentials: [
          {
            service: "app.alpaca.markets",
            email: "owner@example.invalid",
            password: "private-password",
            totp_secret: "private-totp",
            api_key: "PKTEST",
            api_secret: "SKTEST",
            paper_endpoint: "https://paper-api.alpaca.markets/v2",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const execute = vi.fn(async () => ({}));
    const runtime = {
      getService: (name: string) => (name === "browser" ? { execute } : null),
    } as unknown as IAgentRuntime;

    try {
      const result = await fillAlpacaBootstrapSecret(
        runtime,
        {
          field: "email",
          selector: "input[type=email]",
          target: "bridge",
        },
        { credentialsPath },
      );

      expect(result.success).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      const command = execute.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        subaction: "realistic-fill",
        selector: "input[type=email]",
        replace: true,
      });
      expect(command?.value).toBe("owner@example.invalid");
      expect(JSON.stringify(result)).not.toContain(command?.value);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
