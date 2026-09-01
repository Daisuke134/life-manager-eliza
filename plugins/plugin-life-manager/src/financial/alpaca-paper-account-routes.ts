import type { Route, RouteHandlerResult } from "@elizaos/core";
import { captureAlpacaPrivateCredential } from "./alpaca-bootstrap-private-capture.js";
import { fillAlpacaPaperAccountForm } from "./alpaca-paper-account-form.js";

export const alpacaPaperAccountRoutes: Route[] = [
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
      return { status: result.success ? 200 : 409, body: result };
    },
  },
];
