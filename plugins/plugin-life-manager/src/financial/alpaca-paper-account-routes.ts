import type { Route, RouteHandlerResult } from "@elizaos/core";
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
          | "nickname"
          | "funds"
          | "submit",
      );
      return { status: result.success ? 200 : 409, body: result };
    },
  },
];
