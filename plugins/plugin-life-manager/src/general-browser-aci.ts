import { spawn } from "node:child_process";
import type { Action, ActionResult } from "@elizaos/core";

const LOCAL_CDP = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u;
const MAX_PROGRAM = 16_384;
const MAX_OUTPUT = 1_000_000;

function programFrom(options: unknown): string | null {
  const parameters = options && typeof options === "object"
    ? (options as { parameters?: unknown }).parameters
    : null;
  const program = parameters && typeof parameters === "object"
    ? (parameters as { program?: unknown }).program
    : null;
  return typeof program === "string" && program.length > 0 && program.length <= MAX_PROGRAM
    ? program
    : null;
}

export async function runGeneralBrowserAci(
  program: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ActionResult> {
  const cdpUrl = environment.LIFE_MANAGER_BROWSER_CDP_URL?.trim() ?? "";
  if (!LOCAL_CDP.test(cdpUrl)) {
    return { success: false, text: "Authenticated local browser is unavailable." };
  }
  return new Promise((resolve) => {
    const child = spawn("browser-harness", [], {
      env: { ...environment, BU_CDP_URL: cdpUrl, BU_NAME: "life-manager-general" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let oversized = false;
    const append = (current: string, chunk: Buffer): string => {
      if (oversized) return current;
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT) {
        oversized = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", () => resolve({ success: false, text: "Browser ACI failed safely." }));
    child.on("close", (code) => resolve(
      code === 0 && !oversized
        ? { success: true, text: "Browser ACI completed.", data: { output: stdout.trim() } }
        : { success: false, text: "Browser ACI failed safely.", data: { error: stderr.trim().slice(-2_000) } },
    ));
    child.stdin.end(program);
  });
}

export const generalBrowserAciAction: Action = {
  name: "LIFE_MANAGER_GENERAL_BROWSER_ACI",
  description:
    "Observe and operate the current authenticated browser with the installed browser-harness ACI. The model writes the browser program from the live UI; no provider workflow or selector is encoded here.",
  descriptionCompressed: "Use the authenticated general browser ACI.",
  contexts: ["browser", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async () => LOCAL_CDP.test(process.env.LIFE_MANAGER_BROWSER_CDP_URL?.trim() ?? ""),
  handler: async (_runtime, _message, _state, options) => {
    const program = programFrom(options);
    return program
      ? runGeneralBrowserAci(program)
      : { success: false, text: "Browser ACI parameters are invalid." };
  },
  parameters: [{
    name: "program",
    description: "A bounded browser-harness Python program authored from the current goal and live observations.",
    required: true,
    schema: { type: "string", maxLength: MAX_PROGRAM },
  }],
};
