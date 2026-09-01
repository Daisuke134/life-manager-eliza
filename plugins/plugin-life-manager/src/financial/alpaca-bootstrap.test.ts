/**
 * Exercises the deterministic bootstrap boundary with injected adapters. The
 * harness is deliberately mocked: it proves ref reuse, resumable signup
 * signaling, paper-only baseline validation, and public-result redaction.
 */
import { describe, expect, it } from "vitest";
import { ALPACA_CLI_VERSION, runAlpacaBootstrap } from "./alpaca-bootstrap.js";

const requiredCredentialRefs = [
  "credential://alpaca/email",
  "credential://alpaca/api",
] as const;
const checkpoint = { phase: "START" as const, credentialRefs: [] };

function readback(overrides: Record<string, unknown> = {}) {
  return {
    cliVersion: ALPACA_CLI_VERSION,
    paper: true,
    accountStatus: "ACTIVE",
    cash: 100000,
    equity: 100000,
    optionsLevel: 3,
    positionsCount: 0,
    ordersCount: 0,
    activitiesCount: 0,
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  let verifyCalls = 0;
  let signupCalls = 0;
  const deps = {
    requiredCredentialRefs,
    resolveCredentialRefs: async () => ({
      missingRefs: [],
      privateHandle: { secret: "never-public" },
    }),
    runPinnedCliReadbacks: async () => {
      verifyCalls += 1;
      return readback();
    },
    requestSignupStep: async () => {
      signupCalls += 1;
      return {
        status: "continue" as const,
        phase: "SIGNUP" as const,
        nextAction: "CREATE_PAPER_ACCOUNT" as const,
      };
    },
    ...overrides,
  };
  return { deps, counts: () => ({ verifyCalls, signupCalls }) };
}

describe("Life Manager Alpaca bootstrap", () => {
  it("discovers and reuses existing refs, verifies once, and returns no private values", async () => {
    const { deps, counts } = dependencies();
    const result = await runAlpacaBootstrap(
      { phase: "API", credentialRefs: [] },
      deps,
    );
    expect(result.phase).toBe("READY");
    expect(result.facts).toMatchObject({
      paper: true,
      cash: 100000,
      equity: 100000,
      optionsLevel: 3,
    });
    expect(counts()).toEqual({ verifyCalls: 1, signupCalls: 0 });
    expect(result.nextCheckpoint.credentialRefs).toEqual([
      ...requiredCredentialRefs,
    ]);
    expect(JSON.stringify(result)).not.toContain("never-public");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).not.toHaveProperty("accountId");
  });

  it("requires Life Manager account creation from a fresh checkpoint even when login refs already exist", async () => {
    const { deps, counts } = dependencies();
    const result = await runAlpacaBootstrap(checkpoint, deps);
    expect(result).toMatchObject({
      phase: "BOOTSTRAP_REQUIRED",
      nextAction: "CREATE_PAPER_ACCOUNT",
      nextCheckpoint: { phase: "SIGNUP" },
    });
    expect(counts()).toEqual({ verifyCalls: 0, signupCalls: 0 });
  });

  it("returns an explicit resumable signup checkpoint when refs are missing", async () => {
    const { deps, counts } = dependencies({
      resolveCredentialRefs: async () => ({
        missingRefs: [requiredCredentialRefs[0]],
        privateHandle: undefined,
      }),
    });
    const result = await runAlpacaBootstrap(
      { phase: "START", credentialRefs: [] },
      deps,
    );
    expect(result).toMatchObject({
      phase: "BOOTSTRAP_REQUIRED",
      errorCode: "CREDENTIAL_REFS_MISSING",
    });
    expect(result.nextCheckpoint.phase).toBe("SIGNUP");
    expect(result.nextCheckpoint.credentialRefs).toEqual([
      requiredCredentialRefs[1],
    ]);
    expect(counts()).toEqual({ verifyCalls: 0, signupCalls: 1 });
  });

  it.each([
    ["live mode", { paper: false }, "LIVE_MODE_REJECTED"],
    ["wrong cash", { cash: 99999 }, "BASELINE_MISMATCH"],
    ["wrong options level", { optionsLevel: 2 }, "BASELINE_MISMATCH"],
  ])(
    "rejects %s with an explicit code",
    async (_label, override, errorCode) => {
      const { deps } = dependencies({
        runPinnedCliReadbacks: async () => readback(override),
      });
      const result = await runAlpacaBootstrap(
        { phase: "API", credentialRefs: [] },
        deps,
      );
      expect(result).toMatchObject({ phase: "BLOCKED", errorCode });
      expect(result).not.toHaveProperty("facts.cash", 99999);
    },
  );
});
