import type { Route, RouteHandlerResult } from "@elizaos/core";
import {
  advanceAlpacaBootstrapCheckpoint,
  setAlpacaBootstrapCheckpointPhase,
} from "./alpaca-bootstrap-action.js";
import { captureAlpacaPrivateCredential } from "./alpaca-bootstrap-private-capture.js";
import type {
  AlpacaBootstrapCheckpoint,
  AlpacaBootstrapResult,
} from "./alpaca-bootstrap.js";
import { fillAlpacaPaperAccountForm } from "./alpaca-paper-account-form.js";
import {
  runAlpacaCanaryPass,
  type AlpacaCanaryCandidateInput,
} from "./alpaca-canary-pass.js";

export const alpacaPaperAccountRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/life-manager/alpaca/paper-canary",
    rawPath: true,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      const body = context.body as {
        runRef?: unknown;
        candidates?: unknown;
      } | undefined;
      if (
        typeof body?.runRef !== "string" ||
        !Array.isArray(body.candidates)
      ) {
        return { status: 400, body: { error: "canary request is invalid" } };
      }
      try {
        const result = await runAlpacaCanaryPass(context.runtime, {
          runRef: body.runRef,
          candidates: body.candidates as AlpacaCanaryCandidateInput[],
        });
        return {
          status: result.status === "RISK_REJECTED" ? 409 : 200,
          body: result,
        };
      } catch {
        return {
          status: 409,
          body: { error: "Alpaca paper canary failed safely" },
        };
      }
    },
  },
  {
    type: "POST",
    path: "/api/life-manager/alpaca/paper-account-form",
    rawPath: true,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      const body = context.body as { field?: unknown } | undefined;
      const field = body?.field;
      if (
        !(
          [
            "open_switcher",
            "open_form",
            "accept_cookies",
            "select_life_manager",
            "generate_keys",
            "nickname",
            "funds",
            "submit",
          ] as unknown[]
        ).includes(field)
      ) {
        return { status: 400, body: { error: "field is invalid" } };
      }
      const result = await fillAlpacaPaperAccountForm(
        context.runtime,
        field as
          | "open_switcher"
          | "open_form"
          | "accept_cookies"
          | "select_life_manager"
          | "generate_keys"
          | "nickname"
          | "funds"
          | "submit",
      );
      return { status: result.success ? 200 : 409, body: result };
    },
  },
  {
    type: "POST",
    path: "/api/life-manager/alpaca/private-capture",
    rawPath: true,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      const body = context.body as {
        field?: unknown;
        selector?: unknown;
        getMode?: unknown;
        attribute?: unknown;
      } | undefined;
      if (
        !["api_key", "api_secret", "account_id"].includes(String(body?.field)) ||
        typeof body?.selector !== "string" ||
        !["attr", "text", "value"].includes(String(body?.getMode))
      ) {
        return { status: 400, body: { error: "capture parameters are invalid" } };
      }
      const result = await captureAlpacaPrivateCredential(context.runtime, {
        field: body.field as "api_key" | "api_secret" | "account_id",
        selector: body.selector,
        getMode: body.getMode as "attr" | "text" | "value",
        ...(typeof body.attribute === "string" ? { attribute: body.attribute } : {}),
      });
      if (result.success && body.field === "account_id") {
        await setAlpacaBootstrapCheckpointPhase(context.runtime, "API");
      }
      return { status: result.success ? 200 : 409, body: result };
    },
  },
  {
    type: "POST",
    path: "/api/life-manager/alpaca/bootstrap/advance",
    rawPath: true,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      const service = context.runtime.getService("LIFE_MANAGER") as unknown as {
        runLocalAlpacaBootstrap(
          checkpoint: AlpacaBootstrapCheckpoint,
        ): Promise<AlpacaBootstrapResult>;
      } | null;
      if (!service) {
        return { status: 503, body: { error: "Life Manager service unavailable" } };
      }
      const result = await advanceAlpacaBootstrapCheckpoint(
        context.runtime,
        (checkpoint) => service.runLocalAlpacaBootstrap(checkpoint),
      );
      return { status: result.phase === "BLOCKED" ? 409 : 200, body: result };
    },
  },
];
