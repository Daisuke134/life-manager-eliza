import type { Route, RouteHandlerResult } from "@elizaos/core";
import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { decisionReceiptsTable, effectIntentsTable, lifeManagerDbSchema, outcomeReceiptsTable } from "../db/schema.js";
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
import { createLocalAlpacaCliProvider } from "./alpaca-local-adapter.js";
import { renderAlpacaPublicPage } from "./alpaca-public-page.js";
import { buildAlpacaPublicProjection } from "./alpaca-public-projection.js";

type Database = NodePgDatabase<typeof lifeManagerDbSchema>;

export const alpacaPaperAccountRoutes: Route[] = [
  {
    type: "GET",
    path: "/alpaca",
    rawPath: true,
    routeHandler: async (): Promise<RouteHandlerResult> => ({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "cache-control": "no-store",
      },
      body: renderAlpacaPublicPage(),
    }),
  },
  {
    type: "GET",
    path: "/api/life-manager/alpaca/public",
    rawPath: true,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      const db = context.runtime.db as unknown as Database | undefined;
      if (!db || typeof db.select !== "function")
        return { status: 503, body: { error: "Alpaca public projection is unavailable" } };
      const scope = and(
        eq(decisionReceiptsTable.agentId, context.runtime.agentId),
        eq(decisionReceiptsTable.entityId, context.runtime.agentId),
      );
      try {
        const [campaign, decisions, effects, outcomes] = await Promise.all([
          createLocalAlpacaCliProvider().readCampaignSnapshot(),
          db.select({ value: decisionReceiptsTable.decision, createdAt: decisionReceiptsTable.createdAt })
            .from(decisionReceiptsTable).where(scope).orderBy(desc(decisionReceiptsTable.createdAt)).limit(20),
          db.select({ id: effectIntentsTable.id, effectClass: effectIntentsTable.effectClass, status: effectIntentsTable.status, createdAt: effectIntentsTable.createdAt })
            .from(effectIntentsTable).where(and(eq(effectIntentsTable.agentId, context.runtime.agentId), eq(effectIntentsTable.entityId, context.runtime.agentId)))
            .orderBy(desc(effectIntentsTable.createdAt)).limit(100),
          db.select({ effectIntentId: outcomeReceiptsTable.effectIntentId, outcome: outcomeReceiptsTable.outcome, receipt: outcomeReceiptsTable.receipt, createdAt: outcomeReceiptsTable.createdAt })
            .from(outcomeReceiptsTable).where(and(eq(outcomeReceiptsTable.agentId, context.runtime.agentId), eq(outcomeReceiptsTable.entityId, context.runtime.agentId)))
            .orderBy(desc(outcomeReceiptsTable.createdAt)).limit(100),
        ]);
        return { status: 200, body: buildAlpacaPublicProjection({ campaign, decisions, effects, outcomes }) };
      } catch {
        return { status: 503, body: { error: "Alpaca public projection is unavailable" } };
      }
    },
  },
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
      } catch (error) {
        const raw = error && typeof error === "object" && "lastRawResponse" in error &&
          typeof error.lastRawResponse === "string" ? error.lastRawResponse.slice(0, 500) : undefined;
        return {
          status: 409,
          body: {
            error: "Alpaca paper canary failed safely",
            reason: error instanceof Error ? error.message : "Unknown canary failure",
            ...(raw !== undefined ? { modelOutputPreview: raw } : {}),
          },
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
