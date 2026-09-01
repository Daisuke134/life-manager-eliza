/**
 * Binds the bootstrap contract to the local Alpaca CLI and private credential
 * file. Only the six values needed by paper CLI commands cross this adapter
 * boundary; account identifiers and recovery material never enter the handle.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALPACA_CLI_VERSION,
  type AlpacaBootstrapDependencies,
  type AlpacaCliReadback,
  type AlpacaSignupStepResult,
} from "./alpaca-bootstrap.js";

type CliRequest = Parameters<
  AlpacaBootstrapDependencies["runPinnedCliReadbacks"]
>[0];
type SignupRequest = Parameters<
  NonNullable<AlpacaBootstrapDependencies["requestSignupStep"]>
>[0];
type ExecOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly timeout: number;
};
export type AlpacaExecFile = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (
    error: Error | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => void;

export interface AlpacaLocalAdapterOptions {
  readonly credentialsPath?: string;
  readonly cliPath?: string;
  readonly execFile?: AlpacaExecFile;
}

const PAPER_ENDPOINT = "https://paper-api.alpaca.markets/v2";
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REQUIRED_FIELDS = [
  "email",
  "password",
  "totp_secret",
  "api_key",
  "api_secret",
  "paper_endpoint",
] as const;
const REQUIRED_REFS = Object.freeze(
  REQUIRED_FIELDS.map((field) => `credential://alpaca/${field}`),
);
const ACCOUNT_ARGS = [
  "account",
  "get",
  "--quiet",
  "--jq",
  "{accountStatus:.status,cash:(.cash|tonumber),equity:(.equity|tonumber),optionsLevel:.options_trading_level}",
] as const;
const POSITION_ARGS = [
  "position",
  "list",
  "--quiet",
  "--jq",
  "{count:length}",
] as const;
const ORDER_ARGS = [
  "order",
  "list",
  "--quiet",
  "--status",
  "all",
  "--jq",
  "{count:length}",
] as const;
const ACTIVITY_ARGS = [
  "account",
  "activity",
  "list",
  "--quiet",
  "--jq",
  "{count:length}",
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];
type PrivateHandle = Readonly<Record<RequiredField, string>>;

export const ALPACA_REQUIRED_CREDENTIAL_REFS = REQUIRED_REFS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function secretString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8_192 &&
    !hasControl(value)
  );
}

function credentialRecords(
  path: string,
): readonly Record<string, unknown>[] | undefined {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_FILE_BYTES
    )
      return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.credentials) ||
      !parsed.credentials.every(isRecord)
    )
      return undefined;
    return parsed.credentials;
  } catch {
    // error-policy:J3 untrusted local credential input becomes unavailable.
    return undefined;
  }
}

function privateHandle(path: string): PrivateHandle | undefined {
  const records = credentialRecords(path);
  const matches = records?.filter(
    (record) => record.service === "app.alpaca.markets",
  );
  if (matches?.length !== 1) return undefined;
  const record = matches[0];
  if (
    !record ||
    !REQUIRED_FIELDS.every((field) => secretString(record[field])) ||
    record.paper_endpoint !== PAPER_ENDPOINT
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      REQUIRED_FIELDS.map((field) => [field, record[field]]),
    ) as PrivateHandle,
  );
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: Parameters<typeof nodeExecFile>[3],
): void {
  nodeExecFile(file, [...args], { ...options }, callback);
}

function command(
  runner: AlpacaExecFile,
  cliPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    runner(
      cliPath,
      args,
      {
        env,
        shell: false,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Alpaca CLI command failed"));
          return;
        }
        const text =
          typeof stdout === "string" ? stdout : stdout.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
          reject(new Error("Alpaca CLI output exceeds bound"));
          return;
        }
        resolve(text);
      },
    );
  });
}

function json(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES)
      throw new Error("CLI output exceeds bound");
    parsed = JSON.parse(raw.trim());
  } catch {
    // error-policy:J3 untrusted CLI JSON becomes an invalid readback.
    throw new Error("CLI JSON is invalid");
  }
  if (!isRecord(parsed)) throw new Error("CLI JSON is not an object");
  return parsed;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("CLI number is invalid");
  return value;
}

function baseline(
  version: string,
  account: Record<string, unknown>,
  positions: Record<string, unknown>,
  orders: Record<string, unknown>,
  activities: Record<string, unknown>,
): AlpacaCliReadback {
  return {
    cliVersion: version,
    paper: true,
    accountStatus: account.accountStatus === "ACTIVE" ? "ACTIVE" : "UNKNOWN",
    cash: numberField(account, "cash"),
    equity: numberField(account, "equity"),
    optionsLevel: numberField(account, "optionsLevel"),
    positionsCount: numberField(positions, "count"),
    ordersCount: numberField(orders, "count"),
    activitiesCount: numberField(activities, "count"),
  };
}

function unsupportedVersion(): AlpacaCliReadback {
  return {
    cliVersion: "UNSUPPORTED",
    paper: true,
    accountStatus: "UNKNOWN",
    cash: 0,
    equity: 0,
    optionsLevel: 0,
    positionsCount: 0,
    ordersCount: 0,
    activitiesCount: 0,
  };
}

export function createLocalAlpacaBootstrapDependencies(
  options: AlpacaLocalAdapterOptions = {},
): AlpacaBootstrapDependencies {
  const credentialsPath =
    options.credentialsPath ??
    join(homedir(), ".local", "share", "anicca", "credentials.json");
  const cliPath = options.cliPath ?? join(homedir(), ".local", "bin", "alpaca");
  const runner = options.execFile ?? defaultExecFile;
  return {
    requiredCredentialRefs: ALPACA_REQUIRED_CREDENTIAL_REFS,
    resolveCredentialRefs: async (refs) => {
      const handle = privateHandle(credentialsPath);
      const missingRefs = refs.filter((ref) => {
        const index = REQUIRED_REFS.indexOf(ref);
        return index < 0 || !handle;
      });
      return { missingRefs, privateHandle: handle };
    },
    runPinnedCliReadbacks: async (
      request: CliRequest,
      privateValue: unknown,
    ) => {
      if (
        request.cliVersion !== ALPACA_CLI_VERSION ||
        request.paper !== true ||
        !isRecord(privateValue)
      )
        throw new Error("Alpaca CLI request is not paper-pinned");
      const handle = privateValue as Partial<PrivateHandle>;
      if (
        handle.paper_endpoint !== PAPER_ENDPOINT ||
        !secretString(handle.api_key) ||
        !secretString(handle.api_secret)
      )
        throw new Error("Alpaca CLI credentials are unavailable");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ALPACA_API_KEY: handle.api_key,
        ALPACA_SECRET_KEY: handle.api_secret,
        ALPACA_LIVE_TRADE: "false",
      };
      const version = (await command(runner, cliPath, ["version"], env)).trim();
      if (version !== ALPACA_CLI_VERSION) return unsupportedVersion();
      const account = json(await command(runner, cliPath, ACCOUNT_ARGS, env));
      const positions = json(
        await command(runner, cliPath, POSITION_ARGS, env),
      );
      const orders = json(await command(runner, cliPath, ORDER_ARGS, env));
      const activities = json(
        await command(runner, cliPath, ACTIVITY_ARGS, env),
      );
      return baseline(version, account, positions, orders, activities);
    },
    requestSignupStep: async (
      _request: SignupRequest,
      _privateValue: unknown,
    ): Promise<AlpacaSignupStepResult> => ({
      status: "continue",
      phase: "SIGNUP",
      nextAction: "CREATE_PAPER_ACCOUNT",
    }),
  };
}
