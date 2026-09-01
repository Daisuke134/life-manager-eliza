import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  captureAlpacaPrivateCredential,
  fillAlpacaTotp,
} from "./alpaca-bootstrap-private-capture.js";

describe("Alpaca bootstrap private capture", () => {
  it("stores the TOTP secret privately and fills only its current code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lm-alpaca-capture-"));
    const credentialsPath = join(directory, "credentials.json");
    const secret = "JBSWY3DPEHPK3PXP";
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
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ value: `otpauth://totp/Alpaca?secret=${secret}` })
      .mockResolvedValueOnce({});
    const runtime = {
      getService: (name: string) => (name === "browser" ? { execute } : null),
    } as unknown as IAgentRuntime;

    try {
      const capture = await captureAlpacaPrivateCredential(
        runtime,
        { field: "totp_secret", selector: "[data-totp]", getMode: "text" },
        { credentialsPath },
      );
      const fill = await fillAlpacaTotp(
        runtime,
        { selector: "input[name=code]" },
        { credentialsPath },
        0,
      );

      const document = readFileSync(credentialsPath, "utf8");
      const command = execute.mock.calls[1]?.[0];
      expect(document).toContain(secret);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(command).toMatchObject({
        subaction: "realistic-fill",
        selector: "input[name=code]",
        replace: true,
      });
      expect(command?.value).toMatch(/^\d{6}$/u);
      expect(JSON.stringify({ capture, fill })).not.toContain(secret);
      expect(JSON.stringify({ capture, fill })).not.toContain(command?.value);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
