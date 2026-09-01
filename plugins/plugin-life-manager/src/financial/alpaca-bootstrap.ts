/**
 * Owns the resumable normal-email boundary for one dedicated Alpaca paper
 * account. Checkpoints carry opaque credential references only; private
 * credential material stays inside injected adapters, and broker readbacks
 * are reduced to the public paper-baseline facts required by Life Manager.
 */
const MAX_REFS = 32;
const MAX_REF_LENGTH = 512;
const CHECKPOINT_PHASES = [
  "START",
  "SIGNUP",
  "VERIFY",
  "READY",
  "BLOCKED",
] as const;

export const ALPACA_CLI_VERSION = "0.0.14" as const;

export type AlpacaBootstrapCheckpointPhase =
  | "START"
  | "SIGNUP"
  | "VERIFY"
  | "READY"
  | "BLOCKED";

export type AlpacaBootstrapAction =
  | "CREATE_PAPER_ACCOUNT"
  | "RESOLVE_CREDENTIAL_REFS"
  | "VERIFY_EMAIL"
  | "CONFIGURE_MFA"
  | "RUN_TRADING_LOOP"
  | "RETRY_BOOTSTRAP"
  | "RETRY_CLI_READBACK"
  | "ACCOUNT_OWNER_ACTION"
  | "STOP";

type AlpacaSignupNextAction = Exclude<
  AlpacaBootstrapAction,
  "RUN_TRADING_LOOP" | "STOP"
>;

export type AlpacaBootstrapBlockedReason =
  | "CAPTCHA"
  | "KYC"
  | "LEGAL_CONSENT"
  | "ACCOUNT_OWNER_ACTION";

export interface AlpacaBootstrapCheckpoint {
  readonly phase: AlpacaBootstrapCheckpointPhase;
  readonly credentialRefs: readonly string[];
}

export interface AlpacaCredentialResolution {
  /** This handle may contain secrets; it is never copied into a result. */
  readonly privateHandle: unknown;
  readonly missingRefs: readonly string[];
}

export interface AlpacaCliVerificationRequest {
  readonly cliVersion: typeof ALPACA_CLI_VERSION;
  readonly paper: true;
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

export interface AlpacaSignupStepRequest {
  readonly phase: AlpacaBootstrapCheckpointPhase;
  readonly credentialRefs: readonly string[];
  readonly missingRefs: readonly string[];
}

export type AlpacaSignupStepResult =
  | {
      readonly status: "continue";
      readonly phase: AlpacaBootstrapCheckpointPhase;
      readonly nextAction: AlpacaSignupNextAction;
      /** Refs are added to the next checkpoint only when the adapter proves they are bound. */
      readonly boundCredentialRefs?: readonly string[];
    }
  | {
      readonly status: "blocked";
      readonly reason: AlpacaBootstrapBlockedReason;
    };

export interface AlpacaBootstrapDependencies {
  readonly requiredCredentialRefs: readonly string[];
  readonly resolveCredentialRefs: (
    refs: readonly string[],
  ) => Promise<AlpacaCredentialResolution>;
  readonly runPinnedCliReadbacks: (
    request: AlpacaCliVerificationRequest,
    privateHandle: unknown,
  ) => Promise<AlpacaCliReadback>;
  readonly requestSignupStep?: (
    request: AlpacaSignupStepRequest,
    privateHandle: unknown,
  ) => Promise<AlpacaSignupStepResult>;
}

export interface AlpacaBootstrapFacts {
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
}

export type AlpacaBootstrapErrorCode =
  | "CREDENTIAL_REFS_MISSING"
  | "CREDENTIAL_RESOLUTION_FAILED"
  | "SIGNUP_STEP_FAILED"
  | "SIGNUP_STEP_INVALID"
  | "SIGNUP_BLOCKED"
  | "CLI_READBACK_FAILED"
  | "CLI_READBACK_INVALID"
  | "CLI_VERSION_MISMATCH"
  | "LIVE_MODE_REJECTED"
  | "BASELINE_MISMATCH";

interface AlpacaBootstrapBase {
  readonly nextCheckpoint: AlpacaBootstrapCheckpoint;
  readonly facts: AlpacaBootstrapFacts;
}

export type AlpacaBootstrapResult =
  | (AlpacaBootstrapBase & {
      readonly phase: "READY";
      readonly nextAction: "RUN_TRADING_LOOP";
    })
  | (AlpacaBootstrapBase & {
      readonly phase: "BOOTSTRAP_REQUIRED";
      readonly nextAction: Exclude<
        AlpacaBootstrapAction,
        "RUN_TRADING_LOOP" | "STOP"
      >;
      readonly errorCode: "CREDENTIAL_REFS_MISSING";
    })
  | (AlpacaBootstrapBase & {
      readonly phase: "BLOCKED";
      readonly nextAction: Exclude<
        AlpacaBootstrapAction,
        | "RUN_TRADING_LOOP"
        | "CREATE_PAPER_ACCOUNT"
        | "RESOLVE_CREDENTIAL_REFS"
        | "VERIFY_EMAIL"
        | "CONFIGURE_MFA"
      >;
      readonly errorCode: Exclude<
        AlpacaBootstrapErrorCode,
        "CREDENTIAL_REFS_MISSING"
      >;
      readonly blockedReason?: AlpacaBootstrapBlockedReason;
    });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isCheckpointPhase(
  value: unknown,
): value is AlpacaBootstrapCheckpointPhase {
  return (
    typeof value === "string" &&
    CHECKPOINT_PHASES.includes(value as AlpacaBootstrapCheckpointPhase)
  );
}

function isSignupAction(value: unknown): value is AlpacaSignupNextAction {
  return (
    typeof value === "string" &&
    value !== "RUN_TRADING_LOOP" &&
    value !== "STOP"
  );
}

function isBlockedReason(
  value: unknown,
): value is AlpacaBootstrapBlockedReason {
  return (
    value === "CAPTCHA" ||
    value === "KYC" ||
    value === "LEGAL_CONSENT" ||
    value === "ACCOUNT_OWNER_ACTION"
  );
}

function normalizeRefs(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_REFS) {
    throw new Error(`${label} must be a bounded ref list`);
  }
  const refs = value.map((ref) => {
    if (
      typeof ref !== "string" ||
      ref.length === 0 ||
      ref.length > MAX_REF_LENGTH ||
      hasControl(ref)
    ) {
      throw new Error(`${label} contains an invalid ref`);
    }
    return ref;
  });
  if (new Set(refs).size !== refs.length)
    throw new Error(`${label} contains duplicate refs`);
  return Object.freeze(refs);
}

function normalizeCheckpoint(value: unknown): AlpacaBootstrapCheckpoint {
  if (!isRecord(value) || !exactKeys(value, ["phase", "credentialRefs"])) {
    throw new Error("checkpoint must contain only phase and credentialRefs");
  }
  if (!isCheckpointPhase(value.phase)) {
    throw new Error("checkpoint phase is invalid");
  }
  return Object.freeze({
    phase: value.phase as AlpacaBootstrapCheckpointPhase,
    credentialRefs: normalizeRefs(
      value.credentialRefs,
      "checkpoint credentialRefs",
    ),
  });
}

function checkpoint(
  phase: AlpacaBootstrapCheckpointPhase,
  refs: readonly string[],
): AlpacaBootstrapCheckpoint {
  return Object.freeze({ phase, credentialRefs: Object.freeze([...refs]) });
}

function emptyFacts(credentialRefsBound: number): AlpacaBootstrapFacts {
  return {
    credentialRefsBound,
    verified: false,
    paper: false,
    accountStatus: "UNKNOWN",
    cash: null,
    equity: null,
    optionsLevel: null,
    positionsCount: null,
    ordersCount: null,
    activitiesCount: null,
  };
}

function blocked(
  code: Exclude<AlpacaBootstrapErrorCode, "CREDENTIAL_REFS_MISSING">,
  refs: readonly string[],
  credentialRefsBound: number,
  nextAction: Exclude<
    AlpacaBootstrapAction,
    | "RUN_TRADING_LOOP"
    | "CREATE_PAPER_ACCOUNT"
    | "RESOLVE_CREDENTIAL_REFS"
    | "VERIFY_EMAIL"
    | "CONFIGURE_MFA"
  > = "STOP",
  reason?: AlpacaBootstrapBlockedReason,
): AlpacaBootstrapResult {
  return Object.freeze({
    phase: "BLOCKED",
    nextAction,
    errorCode: code,
    ...(reason ? { blockedReason: reason } : {}),
    nextCheckpoint: checkpoint("BLOCKED", refs),
    facts: emptyFacts(credentialRefsBound),
  });
}

function readbackError(
  value: unknown,
):
  | Exclude<
      AlpacaBootstrapErrorCode,
      | "CREDENTIAL_REFS_MISSING"
      | "CREDENTIAL_RESOLUTION_FAILED"
      | "SIGNUP_STEP_FAILED"
      | "SIGNUP_STEP_INVALID"
      | "SIGNUP_BLOCKED"
    >
  | undefined {
  if (!isRecord(value)) return "CLI_READBACK_INVALID";
  if (value.paper === false) return "LIVE_MODE_REJECTED";
  if (
    !exactKeys(value, [
      "cliVersion",
      "paper",
      "accountStatus",
      "cash",
      "equity",
      "optionsLevel",
      "positionsCount",
      "ordersCount",
      "activitiesCount",
    ])
  )
    return "CLI_READBACK_INVALID";
  if (value.cliVersion !== ALPACA_CLI_VERSION) return "CLI_VERSION_MISMATCH";
  if (value.paper !== true) return "BASELINE_MISMATCH";
  if (value.accountStatus !== "ACTIVE") return "BASELINE_MISMATCH";
  if (
    value.cash !== 100000 ||
    value.equity !== 100000 ||
    value.optionsLevel !== 3 ||
    value.positionsCount !== 0 ||
    value.ordersCount !== 0 ||
    value.activitiesCount !== 0
  )
    return "BASELINE_MISMATCH";
  return undefined;
}

function readyFacts(
  readback: AlpacaCliReadback,
  credentialRefsBound: number,
): AlpacaBootstrapFacts {
  return {
    credentialRefsBound,
    verified: true,
    paper: true,
    accountStatus: "ACTIVE",
    cash: readback.cash,
    equity: readback.equity,
    optionsLevel: readback.optionsLevel,
    positionsCount: readback.positionsCount,
    ordersCount: readback.ordersCount,
    activitiesCount: readback.activitiesCount,
  };
}

export async function runAlpacaBootstrap(
  rawCheckpoint: unknown,
  dependencies: AlpacaBootstrapDependencies,
): Promise<AlpacaBootstrapResult> {
  const current = normalizeCheckpoint(rawCheckpoint);
  const required = normalizeRefs(
    dependencies.requiredCredentialRefs,
    "requiredCredentialRefs",
  );
  if (required.length === 0)
    throw new Error("requiredCredentialRefs must not be empty");
  let refs = [...current.credentialRefs];

  let resolution: AlpacaCredentialResolution;
  let missing: string[];
  try {
    resolution = await dependencies.resolveCredentialRefs(required);
    if (!isRecord(resolution))
      throw new Error("credential resolution is invalid");
    missing = [
      ...normalizeRefs(resolution.missingRefs, "resolved missingRefs"),
    ];
  } catch {
    // error-policy:J1 credential resolution is translated to a safe blocked result.
    return blocked("CREDENTIAL_RESOLUTION_FAILED", refs, 0, "RETRY_BOOTSTRAP");
  }
  const requiredSet = new Set(required);
  if (missing.some((ref) => !requiredSet.has(ref))) {
    return blocked("CREDENTIAL_RESOLUTION_FAILED", refs, 0, "RETRY_BOOTSTRAP");
  }
  const uniqueMissing = [...new Set(missing)];
  refs = [
    ...new Set([
      ...refs,
      ...required.filter((ref) => !uniqueMissing.includes(ref)),
    ]),
  ];
  const bound = required.length - uniqueMissing.length;
  if (uniqueMissing.length > 0) {
    let nextPhase: AlpacaBootstrapCheckpointPhase = "SIGNUP";
    let nextAction: AlpacaSignupNextAction = "CREATE_PAPER_ACCOUNT";
    if (dependencies.requestSignupStep) {
      let step: AlpacaSignupStepResult;
      let nextRefs = refs;
      try {
        step = await dependencies.requestSignupStep(
          {
            phase: current.phase,
            credentialRefs: refs,
            missingRefs: Object.freeze(uniqueMissing),
          },
          resolution.privateHandle,
        );
      } catch {
        // error-policy:J1 signup provider failure is translated without echoing private input.
        return blocked("SIGNUP_STEP_FAILED", refs, bound, "RETRY_BOOTSTRAP");
      }
      if (!isRecord(step))
        return blocked("SIGNUP_STEP_INVALID", refs, bound, "RETRY_BOOTSTRAP");
      if (step.status === "blocked") {
        if (!isBlockedReason(step.reason))
          return blocked("SIGNUP_STEP_INVALID", refs, bound, "RETRY_BOOTSTRAP");
        return blocked(
          "SIGNUP_BLOCKED",
          refs,
          bound,
          "ACCOUNT_OWNER_ACTION",
          step.reason,
        );
      }
      if (
        step.status !== "continue" ||
        !isCheckpointPhase(step.phase) ||
        !isSignupAction(step.nextAction)
      ) {
        return blocked("SIGNUP_STEP_INVALID", refs, bound, "RETRY_BOOTSTRAP");
      }
      const newlyBound = normalizeRefs(
        step.boundCredentialRefs ?? [],
        "signup boundCredentialRefs",
      );
      if (newlyBound.some((ref) => !requiredSet.has(ref))) {
        return blocked("SIGNUP_STEP_INVALID", refs, bound, "RETRY_BOOTSTRAP");
      }
      nextRefs = [...new Set([...refs, ...newlyBound])];
      if (nextRefs.length > MAX_REFS)
        return blocked("SIGNUP_STEP_INVALID", refs, bound, "RETRY_BOOTSTRAP");
      nextPhase = step.phase;
      nextAction = step.nextAction;
      refs = nextRefs;
    }
    return Object.freeze({
      phase: "BOOTSTRAP_REQUIRED",
      nextAction,
      errorCode: "CREDENTIAL_REFS_MISSING",
      nextCheckpoint: checkpoint(nextPhase, refs),
      facts: emptyFacts(bound),
    });
  }

  let readback: AlpacaCliReadback;
  try {
    readback = await dependencies.runPinnedCliReadbacks(
      {
        cliVersion: ALPACA_CLI_VERSION,
        paper: true,
        credentialRefs: Object.freeze(refs),
      },
      resolution.privateHandle,
    );
  } catch {
    // error-policy:J1 CLI boundary failure is translated to a retryable redacted result.
    return blocked("CLI_READBACK_FAILED", refs, bound, "RETRY_CLI_READBACK");
  }
  const errorCode = readbackError(readback);
  if (errorCode)
    return blocked(
      errorCode,
      refs,
      bound,
      errorCode === "LIVE_MODE_REJECTED" ? "STOP" : "RETRY_CLI_READBACK",
    );
  return Object.freeze({
    phase: "READY",
    nextAction: "RUN_TRADING_LOOP",
    nextCheckpoint: checkpoint("READY", refs),
    facts: readyFacts(readback, bound),
  });
}
