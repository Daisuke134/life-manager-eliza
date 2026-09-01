/** Interactive BrowserTarget for an already-running local Chromium CDP session. */
import type { Browser, KeyInput, Page } from "puppeteer-core";
import type { BrowserTarget } from "../browser-service.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceTab,
} from "../workspace/browser-workspace-types.js";

const SUPPORTED = new Set([
  "click",
  "fill",
  "get",
  "inspect",
  "list",
  "navigate",
  "open",
  "press",
  "realistic-click",
  "realistic-fill",
  "realistic-press",
  "realistic-type",
  "screenshot",
  "scroll",
  "state",
  "type",
]);

function endpoint(env: NodeJS.ProcessEnv): string | null {
  const raw = env.ELIZA_BROWSER_CDP_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("ELIZA_BROWSER_CDP_URL must be a local HTTP endpoint");
  }
  return url.href.replace(/\/$/, "");
}

async function connectedPage(
  cdpUrl: string,
  requestedId?: string,
): Promise<{ browser: Browser; page: Page }> {
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.default.connect({ browserURL: cdpUrl });
  const pages = await browser.pages();
  const requestedIndex = requestedId?.startsWith("cdp_")
    ? Number(requestedId.slice(4))
    : Number.NaN;
  const page =
    (Number.isInteger(requestedIndex) ? pages[requestedIndex] : undefined) ??
    pages.find((page) => page.url().includes("app.alpaca.markets")) ??
    pages.findLast((page) => page.url() !== "about:blank") ??
    pages[0] ??
    (await browser.newPage());
  return { browser, page };
}

function tab(
  page: Page,
  index: number,
  title: string,
  activePage: Page,
): BrowserWorkspaceTab {
  const now = new Date().toISOString();
  return {
    id: `cdp_${index}`,
    title,
    url: page.url(),
    partition: "cloakbrowser",
    kind: "standard",
    visible: page === activePage,
    createdAt: now,
    updatedAt: now,
    lastFocusedAt: page === activePage ? now : null,
    provider: "cdp",
    status: "ready",
  };
}

async function result(
  browser: Browser,
  command: BrowserWorkspaceCommand,
  page: Page,
  value?: unknown,
): Promise<BrowserWorkspaceCommandResult> {
  const pages = await browser!.pages();
  const index = Math.max(0, pages.indexOf(page));
  return {
    mode: "desktop",
    subaction: command.subaction,
    tab: tab(page, index, await page.title(), page),
    ...(value === undefined ? {} : { value }),
  };
}

async function execute(
  cdpUrl: string,
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  const connection = await connectedPage(cdpUrl, command.id);
  const { browser, page } = connection;
  const selector = command.selector?.trim();
  const timeout = command.timeoutMs ?? 30_000;
  try {
    if (command.subaction === "open" || command.subaction === "navigate") {
      if (!command.url) throw new Error("CDP navigation requires url");
      await page.goto(command.url, { waitUntil: "domcontentloaded", timeout });
    } else if (command.subaction === "list") {
      const pages = await browser.pages();
      return {
        mode: "desktop",
        subaction: "list",
        tabs: await Promise.all(
          pages.map(async (candidate, index) =>
            tab(candidate, index, await candidate.title(), page),
          ),
        ),
      };
    } else if (["click", "realistic-click"].includes(command.subaction)) {
      if (!selector) throw new Error("CDP click requires selector");
      await page.click(selector);
    } else if (["fill", "realistic-fill"].includes(command.subaction)) {
      if (!selector) throw new Error("CDP fill requires selector");
      await page.locator(selector).fill(command.value ?? command.text ?? "");
    } else if (["type", "realistic-type"].includes(command.subaction)) {
      if (!selector) throw new Error("CDP type requires selector");
      await page.type(selector, command.text ?? command.value ?? "");
    } else if (["press", "realistic-press"].includes(command.subaction)) {
      if (selector) await page.focus(selector);
      await page.keyboard.press((command.key ?? "Enter") as KeyInput);
    } else if (command.subaction === "scroll") {
      const pixels = command.pixels ?? 300;
      const sign = command.direction === "up" ? -1 : 1;
      await page.evaluate((amount) => window.scrollBy(0, amount), sign * pixels);
    } else if (command.subaction === "get") {
      if (command.getMode === "url") {
        return await result(browser, command, page, page.url());
      }
      if (command.getMode === "title") {
        return await result(browser, command, page, await page.title());
      }
      if (!selector) throw new Error("CDP get requires selector");
      const value = await page.$eval(
        selector,
        (element, request) => {
          const node = element as HTMLElement & { value?: string };
          if (request.mode === "attr") {
            return node.getAttribute(request.attribute ?? "");
          }
          if (request.mode === "value") return node.value ?? null;
          if (request.mode === "html") return node.innerHTML;
          return node.textContent ?? "";
        },
        { mode: command.getMode, attribute: command.attribute },
      );
      return await result(browser, command, page, value);
    } else if (command.subaction === "inspect") {
      const elements = await page.$$eval(
        "a,button,input,select,textarea,[role='button'],[role='link']",
        (nodes) => {
          const path = (element: Element): string => {
            const parts: string[] = [];
            let current: Element | null = element;
            while (current && current !== document.documentElement) {
              if (current.id) {
                parts.unshift(`#${CSS.escape(current.id)}`);
                break;
              }
              const tag = current.tagName.toLowerCase();
              const siblings = Array.from(current.parentElement?.children ?? []).filter(
                (candidate) => candidate.tagName === current?.tagName,
              );
              parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
              current = current.parentElement;
            }
            return parts.join(" > ");
          };
          return nodes.slice(0, 200).map((element, index) => {
            const node = element as HTMLElement;
            const id = node.id ? `#${CSS.escape(node.id)}` : "";
            const testId = node.getAttribute("data-testid");
            const tested = testId
              ? `${node.tagName.toLowerCase()}[data-testid=${JSON.stringify(testId)}]`
              : "";
            const name = node.getAttribute("name");
            const named = name
              ? `${node.tagName.toLowerCase()}[name=${JSON.stringify(name)}]`
              : "";
            return {
              ref: `cdp_${index}`,
              selector: id || tested || named || path(node),
              tag: node.tagName.toLowerCase(),
              text: (node.innerText || node.getAttribute("aria-label") || "")
                .trim()
                .slice(0, 500),
              type: node.getAttribute("type"),
              name,
              href: node.getAttribute("href"),
              value: null,
            };
          });
        },
      );
      return {
        ...(await result(browser, command, page)),
        elements,
      };
    } else if (command.subaction === "screenshot") {
      const data = await page.screenshot({
        encoding: "base64",
        fullPage: command.fullPage,
      });
      return {
        ...(await result(browser, command, page)),
        snapshot: { data },
      };
    }
    return await result(browser, command, page);
  } finally {
    browser.disconnect();
  }
}

export async function maybeCreateCdpTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserTarget | null> {
  const cdpUrl = endpoint(env);
  if (!cdpUrl) return null;
  return {
    id: "cdp",
    name: "Local Chromium CDP",
    description: "Interactive existing local Chromium session over CDP.",
    kind: "external",
    priority: 200,
    supports: (command) => SUPPORTED.has(command.subaction),
    available: async () => {
      try {
        return (
          await fetch(`${cdpUrl}/json/version`, {
            signal: AbortSignal.timeout(2_000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    execute: (command) => execute(cdpUrl, command),
  };
}
