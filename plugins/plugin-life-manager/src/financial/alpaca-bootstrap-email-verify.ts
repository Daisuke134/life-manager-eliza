/**
 * Reads the Alpaca verification message through the existing authenticated
 * mail CLI and opens only its allowlisted verification URL in BrowserService.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import { setAlpacaBootstrapCheckpointPhase } from "./alpaca-bootstrap-action.js";
import { createLocalAlpacaBootstrapDependencies } from "./alpaca-local-adapter.js";

const GOG_VERSION = "0.17.0";
const MAX_OUTPUT = 1024 * 1024;
type MailExec = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    shell: false;
    encoding: "utf8";
    maxBuffer: number;
    timeout: number;
  },
  callback: (error: Error | null, stdout: string | Buffer) => void,
) => void;

interface EmailVerifyOptions {
  readonly credentialsPath?: string;
  readonly gogPath?: string;
  readonly execFile?: MailExec;
  readonly target?: string;
}
interface BrowserShape {
  execute(
    command: { subaction: "open"; url: string; show: true },
    target?: string,
  ): Promise<unknown>;
}

function defaultExec(
  file: string,
  args: readonly string[],
  options: Parameters<MailExec>[2],
  callback: Parameters<MailExec>[3],
): void {
  nodeExecFile(file, [...args], options, callback);
}

function command(
  run: MailExec,
  file: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    run(
      file,
      args,
      {
        env: { ...process.env },
        shell: false,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error) return reject(new Error("Mail command failed"));
        const value =
          typeof stdout === "string" ? stdout : stdout.toString("utf8");
        if (Buffer.byteLength(value) > MAX_OUTPUT) {
          return reject(new Error("Mail output exceeds bound"));
        }
        resolve(value);
      },
    );
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function verificationUrl(searchRaw: string, detailRaw: string): string {
  const search: unknown = JSON.parse(searchRaw);
  if (!Array.isArray(search)) throw new Error("Mail search result is invalid");
  const matches = search
    .map(record)
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        item?.subject === "Verify your Alpaca account" &&
        typeof item.id === "string",
    )
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (matches.length === 0)
    throw new Error("Verification message is unavailable");
  const detail = record(JSON.parse(detailRaw));
  if (!detail || typeof detail.body !== "string") {
    throw new Error("Verification message body is invalid");
  }
  for (const match of detail.body.matchAll(/href=["']([^"']+)["']/giu)) {
    const raw = match[1]?.replaceAll("&amp;", "&");
    if (!raw) continue;
    const url = new URL(raw);
    if (
      url.protocol === "https:" &&
      url.hostname === "app.alpaca.markets" &&
      url.pathname === "/verify" &&
      url.search.length > 1
    ) {
      return url.toString();
    }
  }
  throw new Error("Allowlisted verification URL is unavailable");
}

export async function executeAlpacaEmailVerification(
  runtime: IAgentRuntime,
  options: EmailVerifyOptions = {},
): Promise<ActionResult> {
  const browser = runtime.getService(
    "browser",
  ) as unknown as BrowserShape | null;
  if (!browser || typeof browser.execute !== "function") {
    return { success: false, text: "BrowserService is unavailable." };
  }
  const dependencies = createLocalAlpacaBootstrapDependencies({
    credentialsPath: options.credentialsPath,
  });
  const resolved = await dependencies.resolveCredentialRefs(
    dependencies.requiredCredentialRefs,
  );
  const handle = resolved.privateHandle as Record<string, unknown> | undefined;
  if (typeof handle?.email !== "string") {
    return { success: false, text: "Alpaca signup email is unavailable." };
  }
  const run = options.execFile ?? defaultExec;
  const gogPath = options.gogPath ?? join(homedir(), ".local", "bin", "gog");
  const version = (await command(run, gogPath, ["version"])).trim();
  if (!version.startsWith(GOG_VERSION)) {
    return { success: false, text: "Pinned mail CLI version is unavailable." };
  }
  const common = [
    "--account",
    handle.email,
    "--json",
    "--results-only",
    "--no-input",
    "--gmail-no-send",
    "gmail",
  ] as const;
  const searchRaw = await command(run, gogPath, [
    ...common,
    "search",
    'subject:"Verify your Alpaca account" newer_than:1d',
  ]);
  const search = JSON.parse(searchRaw) as Array<Record<string, unknown>>;
  const messageId = search
    .filter((item) => item.subject === "Verify your Alpaca account")
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .at(-1)?.id;
  if (typeof messageId !== "string")
    throw new Error("Verification message is unavailable");
  const detailRaw = await command(run, gogPath, [...common, "get", messageId]);
  const url = verificationUrl(searchRaw, detailRaw);
  await browser.execute({ subaction: "open", url, show: true }, options.target);
  await setAlpacaBootstrapCheckpointPhase(runtime, "VERIFY");
  return {
    success: true,
    text: "Alpaca email verification opened through BrowserService.",
    data: { verifiedEmailLinkOpened: true, nextAction: "CONFIGURE_MFA" },
  };
}

export const alpacaBootstrapEmailVerifyAction: Action = {
  name: "ALPACA_BOOTSTRAP_EMAIL_VERIFY",
  description:
    "Read the latest Alpaca verification email without sending mail and open its private allowlisted link.",
  descriptionCompressed: "Open the private Alpaca verification email link.",
  roleGate: { minRole: "OWNER" },
  validate: async (runtime) => runtime.getService("browser") !== null,
  handler: async (runtime, _message, _state, options) => {
    try {
      const target = (
        options as { parameters?: { target?: string } } | undefined
      )?.parameters?.target;
      return await executeAlpacaEmailVerification(runtime, { target });
    } catch {
      // error-policy:J1 mail/browser boundary returns a redacted failure.
      return {
        success: false,
        text: "Alpaca email verification failed safely.",
      };
    }
  },
  parameters: [
    {
      name: "target",
      description: "Optional existing BrowserService target id.",
      required: false,
      schema: { type: "string" },
    },
  ],
};
