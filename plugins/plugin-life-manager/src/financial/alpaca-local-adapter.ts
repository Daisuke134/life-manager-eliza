/**
 * Binds the bootstrap contract to the local Alpaca CLI and private credential
 * file. Bootstrap values remain private; only CLI credentials are injected
 * into the pinned paper CLI process.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  readonly ownerProfilePath?: string;
  readonly cliPath?: string;
  readonly execFile?: AlpacaExecFile;
}

export interface AlpacaMarketObservation {
  readonly paper: true;
  readonly accountStatus: "ACTIVE" | "UNKNOWN";
  readonly cash: number;
  readonly equity: number;
  readonly lastEquity: number;
  readonly optionsLevel: number;
  readonly positionsCount: number;
  readonly openOrdersCount: number;
  readonly regularSessionOpen: boolean;
  readonly observedAt: string;
  readonly symbol: string;
  readonly latestPrice: number;
  readonly latestTradeAt: string;
  readonly optionContracts: number;
}

export interface AlpacaDefinedRiskOrderRequest {
  readonly paper: true;
  readonly clientOrderId: string;
  readonly quantity: number;
  readonly limitPrice: number;
  readonly legs: readonly {
    readonly symbol: string;
    readonly ratioQuantity: number;
    readonly positionIntent:
      "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
  }[];
}

export interface AlpacaPaperOrderReceipt {
  readonly paper: true;
  readonly id: string;
  readonly clientOrderId: string;
  readonly status: string;
}

export interface AlpacaPaperOrderReadback extends AlpacaPaperOrderReceipt {
  readonly submittedAt: string;
  readonly filledQuantity: number;
  readonly filledAveragePrice?: number;
}

export interface AlpacaOptionSnapshot {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly quoteAt: string;
  readonly observedAt: string;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly impliedVolatility: number;
}

export interface AlpacaCampaignPosition {
  readonly symbol: string;
  readonly quantity: number;
  readonly side: "long" | "short";
  readonly averageEntryPrice: number;
  readonly currentPrice: number;
  readonly marketValue: number;
  readonly unrealizedPnl: number;
}

export interface AlpacaCampaignFill {
  readonly id: string;
  readonly orderId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly quantity: number;
  readonly price: number;
  readonly transactionAt: string;
}

export interface AlpacaCampaignSnapshot {
  readonly paper: true;
  readonly cash: number;
  readonly equity: number;
  readonly lastEquity: number;
  readonly positions: readonly AlpacaCampaignPosition[];
  readonly fills: readonly AlpacaCampaignFill[];
  readonly observedAt: string;
}

export interface AlpacaCliProvider {
  observe(symbol: string): Promise<AlpacaMarketObservation>;
  readOptionSnapshots(symbols: readonly string[]): Promise<readonly AlpacaOptionSnapshot[]>;
  findOrderByClientId(clientOrderId: string): Promise<AlpacaPaperOrderReadback | undefined>;
  readCampaignSnapshot(): Promise<AlpacaCampaignSnapshot>;
  submitDefinedRiskOrder(
    request: AlpacaDefinedRiskOrderRequest,
  ): Promise<AlpacaPaperOrderReceipt>;
}

export type AlpacaCapturedCredentialField =
  "totp_secret" | "recovery_code" | "api_key" | "api_secret" | "account_id";

const PAPER_ENDPOINT = "https://paper-api.alpaca.markets/v2";
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REQUIRED_FIELDS = [
  "email",
  "password",
  "totp_secret",
  "recovery_code",
  "api_key",
  "api_secret",
  "account_id",
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
  "{accountStatus:.status,cash:(.cash|tonumber),equity:(.equity|tonumber),lastEquity:(.last_equity|tonumber),optionsLevel:.options_trading_level}",
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
const OPEN_ORDER_ARGS = [
  "order", "list", "--quiet", "--status", "open", "--limit", "500", "--jq", "{count:length}",
] as const;
const CLOCK_ARGS = [
  "clock", "get", "--quiet", "--jq", "{isOpen:.is_open,observedAt:.timestamp}",
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
type PrivateHandle = Readonly<Partial<Record<RequiredField, string>>>;

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
    (record.paper_endpoint !== undefined &&
      record.paper_endpoint !== PAPER_ENDPOINT)
  )
    return undefined;
  return Object.freeze(
    Object.fromEntries(
      REQUIRED_FIELDS.flatMap((field) =>
        secretString(record[field]) ? [[field, record[field]]] : [],
      ),
    ) as PrivateHandle,
  );
}

function ownerEmail(path: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const candidate = isRecord(parsed) ? parsed.candidate : undefined;
  const email = isRecord(candidate) ? candidate.application_email : undefined;
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    !email.includes("@") ||
    hasControl(email)
  )
    throw new Error("Owner profile email is unavailable");
  return email;
}

function writeCredentialDocument(
  credentialsPath: string,
  document: Record<string, unknown>,
): void {
  const temporary = `${credentialsPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, credentialsPath);
  } catch (error) {
    // error-policy:J2 preserve the write failure after best-effort cleanup.
    try {
      unlinkSync(temporary);
    } catch {
      // error-policy:J6 cleanup-only failure cannot replace the write error.
    }
    throw error;
  }
}

export function storeLocalAlpacaCredential(
  field: AlpacaCapturedCredentialField,
  value: string,
  options: Pick<AlpacaLocalAdapterOptions, "credentialsPath"> = {},
): void {
  if (!secretString(value))
    throw new Error("Captured Alpaca credential is invalid");
  const credentialsPath =
    options.credentialsPath ??
    join(homedir(), ".local", "share", "anicca", "credentials.json");
  const records = credentialRecords(credentialsPath);
  const matches = records?.filter(
    (record) => record.service === "app.alpaca.markets",
  );
  if (!records || matches?.length !== 1 || !matches[0]) {
    throw new Error("Alpaca credential record is unavailable");
  }
  const document = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const updated = records.map((record) =>
    record === matches[0]
      ? { ...record, [field]: value, updated_at: new Date().toISOString() }
      : record,
  );
  writeCredentialDocument(credentialsPath, {
    ...document,
    credentials: updated,
  });
}

function seedSignupRecord(
  credentialsPath: string,
  profilePath: string,
): string[] {
  const records = credentialRecords(credentialsPath);
  if (!records) throw new Error("Credential SSOT is unavailable");
  if (records.some((record) => record.service === "app.alpaca.markets")) {
    return [];
  }
  const email = ownerEmail(profilePath);
  const document = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const next = {
    ...document,
    credentials: [
      ...records,
      {
        service: "app.alpaca.markets",
        email,
        username: email,
        password: `${randomBytes(32).toString("base64url")}aA1!`,
        paper_endpoint: PAPER_ENDPOINT,
        account_status: "bootstrap_pending",
        updated_at: new Date().toISOString(),
      },
    ],
  };
  writeCredentialDocument(credentialsPath, next);
  return REQUIRED_REFS.filter(
    (ref) =>
      ref.endsWith("/email") ||
      ref.endsWith("/password") ||
      ref.endsWith("/paper_endpoint"),
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

function safeToken(value: string, name: string): string {
  if (!value || value.length > 128 || hasControl(value)) {
    throw new Error(`Alpaca ${name} is invalid`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error("CLI string is invalid");
  return safeToken(value, field);
}

export function createLocalAlpacaCliProvider(
  options: AlpacaLocalAdapterOptions = {},
): AlpacaCliProvider {
  const credentialsPath =
    options.credentialsPath ??
    join(homedir(), ".local", "share", "anicca", "credentials.json");
  const cliPath = options.cliPath ?? join(homedir(), ".local", "bin", "alpaca");
  const runner = options.execFile ?? defaultExecFile;
  const context = async () => {
    const handle = privateHandle(credentialsPath);
    if (
      handle?.paper_endpoint !== PAPER_ENDPOINT ||
      !secretString(handle.api_key) ||
      !secretString(handle.api_secret)
    )
      throw new Error("Alpaca paper credentials are unavailable");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ALPACA_API_KEY: handle.api_key,
      ALPACA_SECRET_KEY: handle.api_secret,
      ALPACA_LIVE_TRADE: "false",
    };
    const version = (await command(runner, cliPath, ["version"], env)).trim();
    if (version !== ALPACA_CLI_VERSION)
      throw new Error("Alpaca CLI version is not pinned");
    return env;
  };
  return {
    observe: async (rawSymbol) => {
      const symbol = safeToken(rawSymbol.toUpperCase(), "symbol");
      const env = await context();
      const account = json(await command(runner, cliPath, ACCOUNT_ARGS, env));
      const positions = json(await command(runner, cliPath, POSITION_ARGS, env));
      const openOrders = json(await command(runner, cliPath, OPEN_ORDER_ARGS, env));
      const clock = json(await command(runner, cliPath, CLOCK_ARGS, env));
      const trade = json(
        await command(
          runner,
          cliPath,
          [
            "data",
            "latest-trade",
            "--symbol",
            symbol,
            "--quiet",
            "--jq",
            "{symbol:.symbol,price:(.trade.p|tonumber),timestamp:.trade.t}",
          ],
          env,
        ),
      );
      const chain = json(
        await command(
          runner,
          cliPath,
          [
            "data",
            "option",
            "chain",
            "--underlying-symbol",
            symbol,
            "--limit",
            "100",
            "--quiet",
            "--jq",
            "{count:(.snapshots|length)}",
          ],
          env,
        ),
      );
      return {
        paper: true,
        accountStatus:
          account.accountStatus === "ACTIVE" ? "ACTIVE" : "UNKNOWN",
        cash: numberField(account, "cash"),
        equity: numberField(account, "equity"),
        lastEquity: numberField(account, "lastEquity"),
        optionsLevel: numberField(account, "optionsLevel"),
        positionsCount: numberField(positions, "count"),
        openOrdersCount: numberField(openOrders, "count"),
        regularSessionOpen: clock.isOpen === true,
        observedAt: stringField(clock, "observedAt"),
        symbol: stringField(trade, "symbol"),
        latestPrice: numberField(trade, "price"),
        latestTradeAt: stringField(trade, "timestamp"),
        optionContracts: numberField(chain, "count"),
      };
    },
    readOptionSnapshots: async (rawSymbols) => {
      if (rawSymbols.length < 1 || rawSymbols.length > 20)
        throw new Error("Alpaca option symbol count is invalid");
      const symbols = rawSymbols.map((value) => {
        const symbol = safeToken(value.toUpperCase(), "option symbol");
        if (!/^[A-Z]{1,6}\d{6}[CP]\d{8}$/u.test(symbol))
          throw new Error("Alpaca option symbol is invalid");
        return symbol;
      });
      const env = await context();
      const raw = await command(
        runner,
        cliPath,
        [
          "data", "option", "snapshot", "--symbols", symbols.join(","), "--limit", String(symbols.length),
          "--quiet", "--jq",
          ".snapshots|to_entries|map({symbol:.key,bid:.value.latestQuote.bp,ask:.value.latestQuote.ap,quoteAt:.value.latestQuote.t,delta:.value.greeks.delta,gamma:.value.greeks.gamma,theta:.value.greeks.theta,impliedVolatility:.value.impliedVolatility})",
        ],
        env,
      );
      const parsed: unknown = JSON.parse(raw.trim());
      if (!Array.isArray(parsed) || parsed.length !== symbols.length || !parsed.every(isRecord))
        throw new Error("Alpaca option snapshots are incomplete");
      const observedAt = new Date().toISOString();
      return Object.freeze(parsed.map((item) => Object.freeze({
        symbol: stringField(item, "symbol"),
        bid: numberField(item, "bid"),
        ask: numberField(item, "ask"),
        quoteAt: stringField(item, "quoteAt"),
        observedAt,
        delta: numberField(item, "delta"),
        gamma: numberField(item, "gamma"),
        theta: numberField(item, "theta"),
        impliedVolatility: numberField(item, "impliedVolatility"),
      })));
    },
    findOrderByClientId: async (rawClientOrderId) => {
      const clientOrderId = safeToken(rawClientOrderId, "client order ID");
      const env = await context();
      const order = json(
        await command(
          runner,
          cliPath,
          [
            "order", "list", "--status", "all", "--limit", "500", "--nested", "--quiet", "--jq",
            `first(.[] | select(.client_order_id == ${JSON.stringify(clientOrderId)})) // {found:false} | if .found == false then . else {found:true,id:.id,clientOrderId:.client_order_id,status:.status,submittedAt:.submitted_at,filledQuantity:(.filled_qty|tonumber),filledAveragePrice:(if .filled_avg_price then (.filled_avg_price|tonumber) else null end)} end`,
          ],
          env,
        ),
      );
      if (order.found === false) return undefined;
      if (order.found !== true) throw new Error("Alpaca order readback is invalid");
      const average = order.filledAveragePrice;
      if (average !== null && (typeof average !== "number" || !Number.isFinite(average)))
        throw new Error("Alpaca fill price is invalid");
      return {
        paper: true,
        id: stringField(order, "id"),
        clientOrderId: stringField(order, "clientOrderId"),
        status: stringField(order, "status"),
        submittedAt: stringField(order, "submittedAt"),
        filledQuantity: numberField(order, "filledQuantity"),
        ...(typeof average === "number" ? { filledAveragePrice: average } : {}),
      };
    },
    readCampaignSnapshot: async () => {
      const env = await context();
      const account = json(await command(runner, cliPath, ACCOUNT_ARGS, env));
      const positionRaw = await command(
        runner,
        cliPath,
        [
          "position", "list", "--quiet", "--jq",
          "map({symbol:.symbol,quantity:(.qty|tonumber),side:.side,averageEntryPrice:(.avg_entry_price|tonumber),currentPrice:(.current_price|tonumber),marketValue:(.market_value|tonumber),unrealizedPnl:(.unrealized_pl|tonumber)})",
        ],
        env,
      );
      const fillRaw = await command(
        runner,
        cliPath,
        [
          "account", "activity", "list", "--activity-types", "FILL", "--page-size", "100", "--direction", "asc", "--quiet", "--jq",
          "map({id:.id,orderId:.order_id,symbol:.symbol,side:(if .side==\"sell_short\" then \"sell\" else .side end),quantity:(.qty|tonumber),price:(.price|tonumber),transactionAt:.transaction_time})",
        ],
        env,
      );
      const positions: unknown = JSON.parse(positionRaw.trim());
      const fills: unknown = JSON.parse(fillRaw.trim());
      if (!Array.isArray(positions) || !positions.every(isRecord))
        throw new Error("Alpaca campaign positions are invalid");
      if (!Array.isArray(fills) || !fills.every(isRecord))
        throw new Error("Alpaca campaign fills are invalid");
      return Object.freeze({
        paper: true as const,
        cash: numberField(account, "cash"),
        equity: numberField(account, "equity"),
        lastEquity: numberField(account, "lastEquity"),
        positions: Object.freeze(positions.map((position) => Object.freeze({
          symbol: stringField(position, "symbol"),
          quantity: numberField(position, "quantity"),
          side: position.side === "long" ? "long" as const : position.side === "short" ? "short" as const : (() => { throw new Error("Alpaca position side is invalid"); })(),
          averageEntryPrice: numberField(position, "averageEntryPrice"),
          currentPrice: numberField(position, "currentPrice"),
          marketValue: numberField(position, "marketValue"),
          unrealizedPnl: numberField(position, "unrealizedPnl"),
        }))),
        fills: Object.freeze(fills.map((fill) => Object.freeze({
          id: stringField(fill, "id"),
          orderId: stringField(fill, "orderId"),
          symbol: stringField(fill, "symbol"),
          side: fill.side === "buy" ? "buy" as const : fill.side === "sell" ? "sell" as const : (() => { throw new Error("Alpaca fill side is invalid"); })(),
          quantity: numberField(fill, "quantity"),
          price: numberField(fill, "price"),
          transactionAt: stringField(fill, "transactionAt"),
        }))),
        observedAt: new Date().toISOString(),
      });
    },
    submitDefinedRiskOrder: async (request) => {
      if (request.paper !== true)
        throw new Error("Live Alpaca orders are forbidden");
      if (
        !Number.isInteger(request.quantity) ||
        request.quantity < 1 ||
        !Number.isFinite(request.limitPrice) ||
        request.limitPrice <= 0 ||
        request.legs.length < 2 ||
        request.legs.length > 4
      )
        throw new Error("Alpaca defined-risk order is invalid");
      const clientOrderId = safeToken(request.clientOrderId, "client order ID");
      const legs = request.legs.map((leg) => ({
        symbol: safeToken(leg.symbol.toUpperCase(), "option symbol"),
        ratio_qty: String(leg.ratioQuantity),
        position_intent: leg.positionIntent,
      }));
      if (
        legs.some(
          (leg) =>
            !/^\d+$/.test(leg.ratio_qty) ||
            leg.ratio_qty === "0" ||
            ![
              "buy_to_open",
              "sell_to_open",
              "buy_to_close",
              "sell_to_close",
            ].includes(leg.position_intent),
        )
      )
        throw new Error("Alpaca leg ratio is invalid");
      const env = await context();
      const receipt = json(
        await command(
          runner,
          cliPath,
          [
            "order",
            "submit",
            "--order-class",
            "mleg",
            "--qty",
            String(request.quantity),
            "--type",
            "limit",
            "--limit-price",
            String(request.limitPrice),
            "--time-in-force",
            "day",
            "--legs",
            JSON.stringify(legs),
            "--client-order-id",
            clientOrderId,
            "--quiet",
            "--jq",
            "{id:.id,clientOrderId:.client_order_id,status:.status}",
          ],
          env,
        ),
      );
      return {
        paper: true,
        id: stringField(receipt, "id"),
        clientOrderId: stringField(receipt, "clientOrderId"),
        status: stringField(receipt, "status"),
      };
    },
  };
}

export function createLocalAlpacaBootstrapDependencies(
  options: AlpacaLocalAdapterOptions = {},
): AlpacaBootstrapDependencies {
  const credentialsPath =
    options.credentialsPath ??
    join(homedir(), ".local", "share", "anicca", "credentials.json");
  const ownerProfilePath =
    options.ownerProfilePath ??
    join(homedir(), ".config", "anicca", "job-search", "profile.json");
  const cliPath = options.cliPath ?? join(homedir(), ".local", "bin", "alpaca");
  const runner = options.execFile ?? defaultExecFile;
  return {
    requiredCredentialRefs: ALPACA_REQUIRED_CREDENTIAL_REFS,
    resolveCredentialRefs: async (refs) => {
      const handle = privateHandle(credentialsPath);
      const missingRefs = refs.filter((ref) => {
        const index = REQUIRED_REFS.indexOf(ref);
        return index < 0 || !handle?.[REQUIRED_FIELDS[index] as RequiredField];
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
      request: SignupRequest,
      _privateValue: unknown,
    ): Promise<AlpacaSignupStepResult> => {
      const boundCredentialRefs = request.credentialRefs.length
        ? []
        : seedSignupRecord(credentialsPath, ownerProfilePath);
      const missing = new Set(request.missingRefs);
      const needsMfa = ["totp_secret", "recovery_code"].some((field) =>
        missing.has(`credential://alpaca/${field}`),
      );
      const afterEmailVerification = !["START", "SIGNUP"].includes(
        request.phase,
      );
      const phase = afterEmailVerification
        ? needsMfa
          ? "MFA"
          : "API"
        : "SIGNUP";
      const nextAction = afterEmailVerification
        ? needsMfa
          ? "CONFIGURE_MFA"
          : "BIND_API_KEYS"
        : request.phase === "START"
          ? "CREATE_PAPER_ACCOUNT"
          : "VERIFY_EMAIL";
      return {
        status: "continue",
        phase,
        nextAction,
        ...(boundCredentialRefs.length ? { boundCredentialRefs } : {}),
      };
    },
  };
}
