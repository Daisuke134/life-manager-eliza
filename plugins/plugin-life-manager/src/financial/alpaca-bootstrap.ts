/**
 * Advances Alpaca paper-account bootstrap without exposing credentials.
 * Checkpoints contain only opaque vault refs; adapters own signup and CLI I/O.
 */

export const ALPACA_CLI_VERSION = "0.0.14" as const;

export type AlpacaBootstrapCheckpointPhase =
  | "START"
  | "SIGNUP"
  | "VERIFY"
  | "READY"
  | "BLOCKED";
export type AlpacaBootstrapBlockedReason =
  | "CAPTCHA"
  | "KYC"
  | "LEGAL_CONSENT"
  | "ACCOUNT_OWNER_ACTION";
export type AlpacaBootstrapAction =
  | "CREATE_PAPER_ACCOUNT"
  | "VERIFY_EMAIL"
  | "CONFIGURE_MFA"
  | "RETRY_BOOTSTRAP"
  | "RETRY_CLI_READBACK"
  | "ACCOUNT_OWNER_ACTION"
  | "RUN_TRADING_LOOP"
  | "STOP";

export interface AlpacaBootstrapCheckpoint {
  readonly phase: AlpacaBootstrapCheckpointPhase;
  readonly credentialRefs: readonly string[];
}

export interface AlpacaCliReadback {
  readonly cliVersion: string;
  readonly paper: boolean;
  readonly accountStatus: string;
  readonly cash: number;
  readonly equity: number;
  readonly optionsLevel: number;
  readonly positionsCount: number;
  readonly ordersCount: number;
  readonly activitiesCount: number;
}

export type AlpacaSignupStepResult =
  | {
      readonly status: "continue";
      readonly phase: "SIGNUP" | "VERIFY";
      readonly nextAction:
        | "CREATE_PAPER_ACCOUNT"
        | "VERIFY_EMAIL"
        | "CONFIGURE_MFA";
      readonly boundCredentialRefs?: readonly string[];
    }
  | {
      readonly status: "blocked";
      readonly reason: AlpacaBootstrapBlockedReason;
    };

export interface AlpacaBootstrapDependencies {
  readonly requiredCredentialRefs: readonly string[];
  readonly resolveCredentialRefs: (refs: readonly string[]) => Promise<{
    readonly privateHandle: unknown;
    readonly missingRefs: readonly string[];
  }>;
  readonly runPinnedCliReadbacks: (
    request: {
      readonly cliVersion: typeof ALPACA_CLI_VERSION;
      readonly paper: true;
      readonly credentialRefs: readonly string[];
    },
    privateHandle: unknown,
  ) => Promise<AlpacaCliReadback>;
  readonly requestSignupStep?: (
    request: {
      readonly phase: AlpacaBootstrapCheckpointPhase;
      readonly credentialRefs: readonly string[];
      readonly missingRefs: readonly string[];
    },
    privateHandle: unknown,
  ) => Promise<AlpacaSignupStepResult>;
}

type AlpacaBootstrapErrorCode =
  | "CREDENTIAL_REFS_MISSING"
  | "CREDENTIAL_RESOLUTION_FAILED"
  | "SIGNUP_STEP_FAILED"
  | "SIGNUP_BLOCKED"
  | "CLI_READBACK_FAILED"
  | "CLI_VERSION_MISMATCH"
  | "LIVE_MODE_REJECTED"
  | "BASELINE_MISMATCH";

export interface AlpacaBootstrapResult {
  readonly phase: "READY" | "BOOTSTRAP_REQUIRED" | "BLOCKED";
  readonly nextAction: AlpacaBootstrapAction;
  readonly errorCode?: AlpacaBootstrapErrorCode;
  readonly blockedReason?: AlpacaBootstrapBlockedReason;
  readonly nextCheckpoint: AlpacaBootstrapCheckpoint;
  readonly facts: {
    readonly credentialRefsBound: number;
    readonly verified: boolean;
    readonly paper: boolean;
    readonly accountStatus: "UNKNOWN" | "ACTIVE";
    readonly cash: number | null;
    readonly equity: number | null;
    readonly optionsLevel: number | null;
    readonly positionsCount: number | null;
    readonly ordersCount: number | null;
    readonly activitiesCount: number | null;
  };
}

const MAX_REFS = 32;

function validRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  );
}

function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_REFS) {
    throw new Error("credential refs must be a bounded list");
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string" || !validRef(item)) {
      throw new Error("credential ref is invalid");
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("credential refs contain duplicates");
  }
  return Object.freeze(normalized);
}

function checkpoint(
  phase: AlpacaBootstrapCheckpointPhase,
  credentialRefs: readonly string[],
): AlpacaBootstrapCheckpoint {
  return Object.freeze({
    phase,
    credentialRefs: Object.freeze([...credentialRefs]),
  });
}

function facts(bound: number, readback?: AlpacaCliReadback) {
  return Object.freeze({
    credentialRefsBound: bound,
    verified: Boolean(readback),
    paper: readback?.paper === true,
    accountStatus: readback ? ("ACTIVE" as const) : ("UNKNOWN" as const),
    cash: readback?.cash ?? null,
    equity: readback?.equity ?? null,
    optionsLevel: readback?.optionsLevel ?? null,
    positionsCount: readback?.positionsCount ?? null,
    ordersCount: readback?.ordersCount ?? null,
    activitiesCount: readback?.activitiesCount ?? null,
  });
}

function blocked(
  credentialRefs: readonly string[],
  bound: number,
  errorCode: AlpacaBootstrapErrorCode,
  nextAction: AlpacaBootstrapAction,
  blockedReason?: AlpacaBootstrapBlockedReason,
): AlpacaBootstrapResult {
  return Object.freeze({
    phase: "BLOCKED",
    nextAction,
    errorCode,
    ...(blockedReason ? { blockedReason } : {}),
    nextCheckpoint: checkpoint("BLOCKED", credentialRefs),
    facts: facts(bound),
  });
}

function baselineError(
  value: AlpacaCliReadback,
): AlpacaBootstrapErrorCode | undefined {
  if (!value.paper) return "LIVE_MODE_REJECTED";
  if (value.cliVersion !== ALPACA_CLI_VERSION) return "CLI_VERSION_MISMATCH";
  if (
    value.accountStatus !== "ACTIVE" ||
    value.cash !== 100000 ||
    value.equity !== 100000 ||
    value.optionsLevel !== 3 ||
    value.positionsCount !== 0 ||
    value.ordersCount !== 0 ||
    value.activitiesCount !== 0
  ) {
    return "BASELINE_MISMATCH";
  }
  return undefined;
}

export async function runAlpacaBootstrap(
  current: AlpacaBootstrapCheckpoint,
  dependencies: AlpacaBootstrapDependencies,
): Promise<AlpacaBootstrapResult> {
  const currentRefs = refs(current.credentialRefs);
  const required = refs(dependencies.requiredCredentialRefs);
  if (required.length === 0)
    throw new Error("required credential refs are empty");

  let resolution: Awaited<
    ReturnType<typeof dependencies.resolveCredentialRefs>
  >;
  try {
    resolution = await dependencies.resolveCredentialRefs(required);
  } catch {
    // error-policy:J1 secret-store failure becomes a redacted retry state.
    return blocked(
      currentRefs,
      0,
      "CREDENTIAL_RESOLUTION_FAILED",
      "RETRY_BOOTSTRAP",
    );
  }
  const missing = refs(resolution.missingRefs);
  const requiredSet = new Set(required);
  if (missing.some((ref) => !requiredSet.has(ref))) {
    return blocked(
      currentRefs,
      0,
      "CREDENTIAL_RESOLUTION_FAILED",
      "RETRY_BOOTSTRAP",
    );
  }
  let boundRefs = [
    ...new Set([
      ...currentRefs,
      ...required.filter((ref) => !missing.includes(ref)),
    ]),
  ];
  const bound = required.length - missing.length;

  if (missing.length > 0) {
    let step: AlpacaSignupStepResult = {
      status: "continue",
      phase: "SIGNUP",
      nextAction: "CREATE_PAPER_ACCOUNT",
    };
    if (dependencies.requestSignupStep) {
      try {
        step = await dependencies.requestSignupStep(
          {
            phase: current.phase,
            credentialRefs: boundRefs,
            missingRefs: missing,
          },
          resolution.privateHandle,
        );
      } catch {
        // error-policy:J1 browser/mail failure becomes a redacted retry state.
        return blocked(
          boundRefs,
          bound,
          "SIGNUP_STEP_FAILED",
          "RETRY_BOOTSTRAP",
        );
      }
    }
    if (step.status === "blocked") {
      return blocked(
        boundRefs,
        bound,
        "SIGNUP_BLOCKED",
        "ACCOUNT_OWNER_ACTION",
        step.reason,
      );
    }
    const newlyBound = refs(step.boundCredentialRefs ?? []);
    if (newlyBound.some((ref) => !requiredSet.has(ref))) {
      return blocked(boundRefs, bound, "SIGNUP_STEP_FAILED", "RETRY_BOOTSTRAP");
    }
    boundRefs = [...new Set([...boundRefs, ...newlyBound])];
    return Object.freeze({
      phase: "BOOTSTRAP_REQUIRED",
      nextAction: step.nextAction,
      errorCode: "CREDENTIAL_REFS_MISSING",
      nextCheckpoint: checkpoint(step.phase, boundRefs),
      facts: facts(boundRefs.filter((ref) => requiredSet.has(ref)).length),
    });
  }

  let readback: AlpacaCliReadback;
  try {
    readback = await dependencies.runPinnedCliReadbacks(
      {
        cliVersion: ALPACA_CLI_VERSION,
        paper: true,
        credentialRefs: boundRefs,
      },
      resolution.privateHandle,
    );
  } catch {
    // error-policy:J1 CLI failure becomes a redacted retry state.
    return blocked(
      boundRefs,
      bound,
      "CLI_READBACK_FAILED",
      "RETRY_CLI_READBACK",
    );
  }
  const errorCode = baselineError(readback);
  if (errorCode) {
    return blocked(
      boundRefs,
      bound,
      errorCode,
      errorCode === "LIVE_MODE_REJECTED" ? "STOP" : "RETRY_CLI_READBACK",
    );
  }
  return Object.freeze({
    phase: "READY",
    nextAction: "RUN_TRADING_LOOP",
    nextCheckpoint: checkpoint("READY", boundRefs),
    facts: facts(bound, readback),
  });
}
