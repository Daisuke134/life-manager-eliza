import { spawn } from "node:child_process";
import type { Action, ActionResult } from "@elizaos/core";

const LOCAL_CDP = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u;
const MAX_OUTPUT = 1_000_000;
const WEB_URL = /^https?:\/\/[^\s]{1,4096}$/u;

type ReadOperation = "observe" | "links" | "accessibility" | "navigate";

interface ReadRequest {
  readonly operation: ReadOperation;
  readonly url?: string;
}

function requestFrom(options: unknown): ReadRequest | null {
  const parameters = options && typeof options === "object"
    ? (options as { parameters?: unknown }).parameters
    : null;
  if (!parameters || typeof parameters !== "object") return null;
  const { operation, url } = parameters as { operation?: unknown; url?: unknown };
  if (!(["observe", "links", "accessibility", "navigate"] as const).includes(operation as ReadOperation)) {
    return null;
  }
  if (operation === "navigate") {
    return typeof url === "string" && WEB_URL.test(url)
      ? { operation, url }
      : null;
  }
  return url === undefined ? { operation: operation as ReadOperation } : null;
}

function readProgram(request: ReadRequest): string {
  if (request.operation === "navigate") {
    return `new_tab(${JSON.stringify(request.url)})\nwait_for_load()\nprint(page_info())`;
  }
  if (request.operation === "links") {
    return `ensure_real_tab()\nprint(js("[...document.querySelectorAll('a[href]')].slice(0,1000).map(a=>({text:a.innerText.trim().slice(0,300),href:a.href}))"))`;
  }
  if (request.operation === "accessibility") {
    return `ensure_real_tab()\nnodes=cdp("Accessibility.getFullAXTree")["nodes"]\nprint([{"role":n.get("role",{}).get("value"),"name":n.get("name",{}).get("value"),"backendDOMNodeId":n.get("backendDOMNodeId")} for n in nodes if n.get("name",{}).get("value")][:1000])`;
  }
  return `ensure_real_tab()\nprint(page_info())\nprint(js("({url:location.href,title:document.title,text:document.body.innerText.slice(0,100000)})"))`;
}

export async function runGeneralBrowserAci(
  request: ReadRequest,
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
    child.stdin.end(readProgram(request));
  });
}

export const generalBrowserAciAction: Action = {
  name: "LIFE_MANAGER_GENERAL_BROWSER_ACI",
  description:
    "Read or navigate the current authenticated browser through the installed browser-harness ACI. This action cannot click, fill, upload, or submit; irreversible operations require a sealed intent and the effect kernel.",
  descriptionCompressed: "Read the authenticated general browser safely.",
  contexts: ["browser", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async () => LOCAL_CDP.test(process.env.LIFE_MANAGER_BROWSER_CDP_URL?.trim() ?? ""),
  handler: async (_runtime, _message, _state, options) => {
    const request = requestFrom(options);
    return request
      ? runGeneralBrowserAci(request)
      : { success: false, text: "Browser ACI parameters are invalid." };
  },
  parameters: [
    {
      name: "operation",
      description: "Read the current page, list links, read the accessibility tree, or navigate to one URL.",
      required: true,
      schema: { type: "string", enum: ["observe", "links", "accessibility", "navigate"] },
    },
    {
      name: "url",
      description: "Exact HTTP(S) URL, required only for navigate.",
      required: false,
      schema: { type: "string", maxLength: 4_096 },
    },
  ],
};
