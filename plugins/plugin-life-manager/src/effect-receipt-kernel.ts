import { isDeepStrictEqual } from "node:util";
import {
  type AppliedEffectReceipt,
  type CommittedEffectReceipt,
  type EffectReceipt,
  type EffectResourceRef,
  normalizeEffectReceipt,
} from "@elizaos/core";

const MAX_REFERENCE_LENGTH = 512;
const MAX_INPUT_REFS = 64;
const MAX_INPUT_REFS_BYTES = 16 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface EffectReceiptKernelRequest {
  readonly effectKey: string;
  readonly operation: string;
  readonly resource: EffectResourceRef;
  readonly inputRefs: Readonly<Record<string, string>>;
}

export type EffectReceiptKernelInspection =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly receipt: unknown }
  | { readonly state: "unknown" };

type MaybePromise<T> = T | PromiseLike<T>;

export interface EffectReceiptKernelDependencies {
  readonly inspect: (
    request: EffectReceiptKernelRequest,
  ) => MaybePromise<EffectReceiptKernelInspection>;
  readonly executeOnce: (
    request: EffectReceiptKernelRequest,
  ) => MaybePromise<unknown>;
  readonly verifyReceipt: (
    raw: unknown,
    request: EffectReceiptKernelRequest,
    replayed: boolean,
  ) => MaybePromise<unknown>;
}

export type EffectReceiptKernelResult =
  | {
      readonly receipt: CommittedEffectReceipt;
      readonly effect_started: false;
      readonly replayed: true;
    }
  | {
      readonly receipt: AppliedEffectReceipt;
      readonly effect_started: true;
      readonly replayed: false;
    };

export const EFFECT_RECEIPT_KERNEL_UNKNOWN = "EFFECT_RECEIPT_KERNEL_UNKNOWN" as const;
export const EFFECT_RECEIPT_KERNEL_ABSENT = "EFFECT_RECEIPT_KERNEL_ABSENT" as const;
export const EFFECT_RECEIPT_KERNEL_EXECUTION_FAILED =
  "EFFECT_RECEIPT_KERNEL_EXECUTION_FAILED" as const;
export const EFFECT_RECEIPT_KERNEL_INVALID_RECEIPT =
  "EFFECT_RECEIPT_KERNEL_INVALID_RECEIPT" as const;
export const EFFECT_RECEIPT_KERNEL_DEPENDENCY_MISSING =
  "EFFECT_RECEIPT_KERNEL_DEPENDENCY_MISSING" as const;

export type EffectReceiptKernelErrorCode =
  | typeof EFFECT_RECEIPT_KERNEL_UNKNOWN
  | typeof EFFECT_RECEIPT_KERNEL_ABSENT
  | typeof EFFECT_RECEIPT_KERNEL_EXECUTION_FAILED
  | typeof EFFECT_RECEIPT_KERNEL_INVALID_RECEIPT
  | typeof EFFECT_RECEIPT_KERNEL_DEPENDENCY_MISSING;

export class EffectReceiptKernelError extends Error {
  readonly code: EffectReceiptKernelErrorCode;
  readonly unknownEffect: boolean;

  constructor(
    message: string,
    code: EffectReceiptKernelErrorCode,
    unknownEffect: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "EffectReceiptKernelError";
    this.code = code;
    this.unknownEffect = unknownEffect;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function reference(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > MAX_REFERENCE_LENGTH ||
    CONTROL.test(value)
  ) {
    throw new Error(`${field} must be a bounded reference`);
  }
  return value.trim();
}

function normalizeResource(
  value: unknown,
  field: string,
): EffectResourceRef {
  const raw = record(value, field);
  const keys = Object.hasOwn(raw, "version")
    ? ["kind", "id", "version"]
    : ["kind", "id"];
  exactKeys(raw, keys, field);
  return Object.freeze({
    kind: reference(raw.kind, `${field}.kind`),
    id: reference(raw.id, `${field}.id`),
    ...(Object.hasOwn(raw, "version")
      ? { version: reference(raw.version, `${field}.version`) }
      : {}),
  });
}

function normalizeInputRefs(
  value: unknown,
): Readonly<Record<string, string>> {
  const raw = record(value, "inputRefs");
  const keys = Object.keys(raw);
  if (keys.length > MAX_INPUT_REFS) {
    throw new Error("inputRefs exceeds the reference bound");
  }
  const refs: Record<string, string> = {};
  for (const key of keys) {
    const normalizedKey = reference(key, "inputRefs key");
    refs[normalizedKey] = reference(raw[key], `inputRefs.${normalizedKey}`);
  }
  if (Buffer.byteLength(JSON.stringify(refs), "utf8") > MAX_INPUT_REFS_BYTES) {
    throw new Error("inputRefs exceeds the reference bound");
  }
  return Object.freeze(refs);
}

export function normalizeEffectReceiptKernelRequest(
  value: unknown,
): EffectReceiptKernelRequest {
  const raw = record(value, "effect receipt kernel request");
  exactKeys(raw, ["effectKey", "operation", "resource", "inputRefs"], "request");
  return Object.freeze({
    effectKey: reference(raw.effectKey, "effectKey"),
    operation: reference(raw.operation, "operation"),
    resource: normalizeResource(raw.resource, "resource"),
    inputRefs: normalizeInputRefs(raw.inputRefs),
  });
}

function normalizeInspection(value: unknown): EffectReceiptKernelInspection {
  const raw = record(value, "effect receipt readback");
  if (raw.state === "absent" || raw.state === "unknown") {
    exactKeys(raw, ["state"], "readback");
    return Object.freeze({ state: raw.state });
  }
  if (raw.state === "present") {
    exactKeys(raw, ["state", "receipt"], "readback");
    if (!Object.hasOwn(raw, "receipt")) {
      throw new Error("present readback must contain a receipt");
    }
    return Object.freeze({ state: "present", receipt: raw.receipt });
  }
  throw new Error("effect receipt readback state is invalid");
}

const PRIVATE_RECEIPT_KEYS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "args",
  "authorization",
  "command",
  "cookie",
  "credential",
  "credentials",
  "cwd",
  "env",
  "environment",
  "executable",
  "password",
  "private",
  "private_payload",
  "refreshtoken",
  "secret",
  "shell",
  "stderr",
  "stdout",
  "token",
]);

function containsPrivateReceiptKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let count = 0;
  while (pending.length > 0) {
    if (++count > 10_000) return true;
    const item = pending.pop();
    if (item === null || typeof item !== "object") continue;
    if (visited.has(item)) continue;
    visited.add(item);
    if (Array.isArray(item)) {
      pending.push(...item);
      continue;
    }
    for (const [key, nested] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (
        PRIVATE_RECEIPT_KEYS.has(normalized) ||
        normalized.startsWith("private")
      ) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

function invalidReceipt(
  message: string,
  cause?: unknown,
): EffectReceiptKernelError {
  return new EffectReceiptKernelError(
    message,
    EFFECT_RECEIPT_KERNEL_INVALID_RECEIPT,
    true,
    cause,
  );
}

function normalizeVerifiedReceipt(
  raw: unknown,
  request: EffectReceiptKernelRequest,
  replayed: boolean,
  verifyReceipt: EffectReceiptKernelDependencies["verifyReceipt"],
): Promise<CommittedEffectReceipt> {
  return Promise.resolve()
    .then(() => verifyReceipt(raw, request, replayed))
    .then((verified) => {
      if (containsPrivateReceiptKey(verified)) {
        throw invalidReceipt("Effect receipt contains private fields");
      }
      const receipt = normalizeEffectReceipt(verified);
      if (
        receipt.operation !== request.operation ||
        !isDeepStrictEqual(receipt.resource, request.resource) ||
        receipt.idempotency.key !== request.effectKey ||
        receipt.idempotency.replayed !== replayed
      ) {
        throw invalidReceipt("Effect receipt does not match the exact request");
      }
      if (replayed) {
        if (
          receipt.outcome !== "applied" &&
          !(receipt.outcome === "noop" && receipt.idempotency.replayed)
        ) {
          throw invalidReceipt("Replayed receipt is not committed");
        }
        return receipt as CommittedEffectReceipt;
      }
      if (receipt.outcome !== "applied") {
        throw invalidReceipt("Fresh effect receipt is not applied");
      }
      return receipt as AppliedEffectReceipt;
    })
    .catch((error: unknown) => {
      if (error instanceof EffectReceiptKernelError) throw error;
      throw invalidReceipt("Effect receipt verification failed", error);
    });
}

function unknownError(message: string, cause?: unknown): EffectReceiptKernelError {
  return new EffectReceiptKernelError(
    message,
    EFFECT_RECEIPT_KERNEL_UNKNOWN,
    true,
    cause,
  );
}

function dependencyError(name: string): EffectReceiptKernelError {
  return new EffectReceiptKernelError(
    `Effect receipt kernel dependency missing: ${name}`,
    EFFECT_RECEIPT_KERNEL_DEPENDENCY_MISSING,
    false,
  );
}

function explicitKnownFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    (error as Record<string, unknown>).unknownEffect === false
  );
}

export async function runEffectReceiptKernel(
  request: EffectReceiptKernelRequest,
  dependencies: EffectReceiptKernelDependencies,
): Promise<EffectReceiptKernelResult> {
  const safeRequest = normalizeEffectReceiptKernelRequest(request);
  if (!dependencies || typeof dependencies !== "object") {
    throw dependencyError("dependencies");
  }
  for (const name of ["inspect", "executeOnce", "verifyReceipt"] as const) {
    if (typeof dependencies[name] !== "function") throw dependencyError(name);
  }

  let before: EffectReceiptKernelInspection;
  try {
    before = normalizeInspection(await dependencies.inspect(safeRequest));
  } catch (error) {
    throw unknownError("Pre-effect readback is unknown", error);
  }
  if (before.state === "unknown") {
    throw unknownError("Pre-effect readback is unknown");
  }
  if (before.state === "present") {
    const receipt = await normalizeVerifiedReceipt(
      before.receipt,
      safeRequest,
      true,
      dependencies.verifyReceipt,
    );
    return Object.freeze({ receipt, effect_started: false, replayed: true });
  }

  try {
    await dependencies.executeOnce(safeRequest);
  } catch (error) {
    throw new EffectReceiptKernelError(
      "Effect execution failed",
      EFFECT_RECEIPT_KERNEL_EXECUTION_FAILED,
      !explicitKnownFailure(error),
      error,
    );
  }

  let after: EffectReceiptKernelInspection;
  try {
    after = normalizeInspection(await dependencies.inspect(safeRequest));
  } catch (error) {
    throw unknownError("Post-effect readback is unknown", error);
  }
  if (after.state === "unknown") {
    throw unknownError("Post-effect readback is unknown");
  }
  if (after.state === "absent") {
    throw new EffectReceiptKernelError(
      "Post-effect readback did not confirm the effect",
      EFFECT_RECEIPT_KERNEL_ABSENT,
      false,
    );
  }
  const receipt = await normalizeVerifiedReceipt(
    after.receipt,
    safeRequest,
    false,
    dependencies.verifyReceipt,
  );
  if (receipt.outcome !== "applied") {
    throw invalidReceipt("Post-effect receipt is not applied");
  }
  return Object.freeze({
    receipt: receipt as AppliedEffectReceipt,
    effect_started: true,
    replayed: false,
  });
}
