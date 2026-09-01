/**
 * Verifies the local Alpaca adapter against a temporary 0600 credential file
 * and an injected execFile boundary. No network, real account, or real secret
 * is used; command argv, paper env, redaction, and typed baseline are checked.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAlpacaBootstrap } from "./alpaca-bootstrap.js";
import { createLocalAlpacaBootstrapDependencies } from "./alpaca-local-adapter.js";

describe("local Alpaca adapter", () => {
  it("loads only required refs and runs the fixed paper CLI readbacks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lm-alpaca-adapter-"));
    const credentialsPath = join(directory, "credentials.json");
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        credentials: [
          {
            service: "app.alpaca.markets",
            email: "test@example.invalid",
            password: "test-password",
            totp_secret: "test-totp",
            api_key: "PKTEST",
            api_secret: "SKTEST",
            paper_endpoint: "https://paper-api.alpaca.markets/v2",
            account_id: "private-account-id",
            recovery_code: "private-recovery-code",
          },
        ],
      }),
      { mode: 0o600 },
    );
    chmodSync(credentialsPath, 0o600);

    const calls: Array<{
      file: string;
      args: readonly string[];
      shell: boolean;
      env: NodeJS.ProcessEnv;
    }> = [];
    const execFile = (
      file: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv; shell: false },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({
        file,
        args: [...args],
        shell: options.shell,
        env: options.env,
      });
      const output =
        args[0] === "version"
          ? "0.0.14\n"
          : args[0] === "account" && args[1] === "get"
            ? '{"accountStatus":"ACTIVE","cash":100000,"equity":100000,"optionsLevel":3}\n'
            : args[0] === "position"
              ? '{"count":0}\n'
              : args[0] === "order"
                ? '{"count":0}\n'
                : '{"count":0}\n';
      callback(null, output, "");
    };

    try {
      const dependencies = createLocalAlpacaBootstrapDependencies({
        credentialsPath,
        cliPath: "/tmp/test-alpaca",
        execFile,
      });
      const resolution = await dependencies.resolveCredentialRefs(
        dependencies.requiredCredentialRefs,
      );
      expect(Object.keys(resolution.privateHandle as object).sort()).toEqual([
        "api_key",
        "api_secret",
        "email",
        "paper_endpoint",
        "password",
        "totp_secret",
      ]);

      const result = await runAlpacaBootstrap(
        { phase: "START", credentialRefs: [] },
        dependencies,
      );
      expect(result).toMatchObject({
        phase: "READY",
        facts: {
          paper: true,
          accountStatus: "ACTIVE",
          cash: 100000,
          equity: 100000,
          optionsLevel: 3,
          positionsCount: 0,
          ordersCount: 0,
          activitiesCount: 0,
        },
      });
      expect(calls.map(({ args }) => args)).toEqual([
        ["version"],
        [
          "account",
          "get",
          "--quiet",
          "--jq",
          "{accountStatus:.status,cash:(.cash|tonumber),equity:(.equity|tonumber),optionsLevel:.options_trading_level}",
        ],
        ["position", "list", "--quiet", "--jq", "{count:length}"],
        [
          "order",
          "list",
          "--quiet",
          "--status",
          "all",
          "--jq",
          "{count:length}",
        ],
        ["account", "activity", "list", "--quiet", "--jq", "{count:length}"],
      ]);
      expect(
        calls.every(
          ({ file, shell }) => file === "/tmp/test-alpaca" && shell === false,
        ),
      ).toBe(true);
      expect(calls[0]?.env.ALPACA_LIVE_TRADE).toBe("false");
      expect(calls[0]?.env.ALPACA_API_KEY).toBe("PKTEST");
      expect(calls[0]?.env.ALPACA_SECRET_KEY).toBe("SKTEST");
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain("private-account-id");
      expect(publicResult).not.toContain("private-recovery-code");
      expect(publicResult).not.toContain("test-password");
      expect(publicResult).not.toContain("SKTEST");
      expect(readFileSync(credentialsPath, "utf8")).toContain(
        "private-account-id",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("seeds only normal-email signup material into the private SSOT", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lm-alpaca-seed-"));
    const credentialsPath = join(directory, "credentials.json");
    const ownerProfilePath = join(directory, "profile.json");
    writeFileSync(credentialsPath, '{"version":1,"credentials":[]}\n', {
      mode: 0o600,
    });
    writeFileSync(
      ownerProfilePath,
      JSON.stringify({
        candidate: { application_email: "owner@example.invalid" },
      }),
      { mode: 0o600 },
    );
    try {
      const dependencies = createLocalAlpacaBootstrapDependencies({
        credentialsPath,
        ownerProfilePath,
      });
      const result = await runAlpacaBootstrap(
        { phase: "START", credentialRefs: [] },
        dependencies,
      );
      expect(result).toMatchObject({
        phase: "BOOTSTRAP_REQUIRED",
        nextAction: "CREATE_PAPER_ACCOUNT",
        facts: { credentialRefsBound: 3 },
      });
      expect(result.nextCheckpoint.credentialRefs).toHaveLength(3);
      const saved = JSON.parse(readFileSync(credentialsPath, "utf8"));
      expect(saved.credentials).toHaveLength(1);
      expect(saved.credentials[0]).toMatchObject({
        service: "app.alpaca.markets",
        email: "owner@example.invalid",
        paper_endpoint: "https://paper-api.alpaca.markets/v2",
        account_status: "bootstrap_pending",
      });
      expect(saved.credentials[0].password).toMatch(/^.{40,}aA1!$/);
      expect(saved.credentials[0]).not.toHaveProperty("api_key");
      expect(saved.credentials[0]).not.toHaveProperty("account_id");
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result)).not.toContain(
        saved.credentials[0].password,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
