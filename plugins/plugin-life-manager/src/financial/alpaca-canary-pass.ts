import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { stringToUuid, type IAgentRuntime } from "@elizaos/core";
import {
  effectIntentsTable,
  goalsTable,
  lifeManagerDbSchema,
  outcomeReceiptsTable,
} from "../db/schema.js";
import { persistGoalWorkItem } from "../goal-work-item.js";
import { decideAndPersistAlpacaTrade } from "./alpaca-decision.js";
import { createLocalAlpacaCliProvider, type AlpacaCampaignSnapshot } from "./alpaca-local-adapter.js";
import { reconcileAlpacaPaperCanaryReadback, runAlpacaPaperCanary, sealAlpacaPaperCanary } from "./alpaca-paper-canary.js";
import { evaluateAlpacaRisk } from "./alpaca-risk-gate.js";

export interface AlpacaCanaryCandidateInput {
  readonly candidateRef: string;
  readonly structure: "bull_call_debit_spread" | "bear_put_debit_spread";
  readonly buySymbol: string;
  readonly sellSymbol: string;
}

export interface AlpacaCanaryPassRequest {
  readonly runRef: string;
  readonly candidates: readonly AlpacaCanaryCandidateInput[];
}

type Database = NodePgDatabase<typeof lifeManagerDbSchema>;
const OPTION = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/u;

function contract(symbol: string) {
  const match = OPTION.exec(symbol);
  if (!match) throw new Error("Alpaca canary option symbol is invalid");
  return {
    root: match[1],
    expiry: match[2],
    kind: match[3],
    strike: Number(match[4]) / 1_000,
  };
}

function dte(expiry: string, now: Date): number {
  const year = 2000 + Number(expiry.slice(0, 2));
  const month = Number(expiry.slice(2, 4));
  const day = Number(expiry.slice(4, 6));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(year, month - 1, day) - today) / 86_400_000);
}

function validateCandidate(value: AlpacaCanaryCandidateInput, now: Date) {
  if (!value.candidateRef || value.candidateRef.length > 256)
    throw new Error("Alpaca canary candidate ref is invalid");
  const buy = contract(value.buySymbol);
  const sell = contract(value.sellSymbol);
  if (buy.root !== "SPY" || sell.root !== buy.root || sell.expiry !== buy.expiry || sell.kind !== buy.kind)
    throw new Error("Alpaca canary spread legs do not match");
  const call = value.structure === "bull_call_debit_spread";
  if ((call && (buy.kind !== "C" || buy.strike >= sell.strike)) ||
      (!call && (buy.kind !== "P" || buy.strike <= sell.strike)))
    throw new Error("Alpaca canary spread structure is invalid");
  return { ...value, dte: dte(buy.expiry, now) };
}

function requestFingerprint(candidates: readonly AlpacaCanaryCandidateInput[]): string {
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}

async function ensureWorkItem(runtime: IAgentRuntime, db: Database, runRef: string, fingerprint: string, now: Date) {
  const agentId = runtime.agentId;
  const entityId = runtime.agentId;
  const goalId = stringToUuid(`life-manager:alpaca:paper-canary:${runRef}`);
  await db.insert(goalsTable).values({
    id: goalId,
    agentId,
    entityId,
    statement: "Evaluate and, only if allowed, place one defined-risk Alpaca paper options canary.",
    provenance: { kind: "owner_goal", runRef, fingerprint },
    status: "active",
  }).onConflictDoNothing();
  const goal = (await db.select({ provenance: goalsTable.provenance }).from(goalsTable).where(and(
    eq(goalsTable.agentId, agentId),
    eq(goalsTable.entityId, entityId),
    eq(goalsTable.id, goalId),
  )).limit(1))[0];
  if (!goal || typeof goal.provenance !== "object" || goal.provenance === null ||
      (goal.provenance as { fingerprint?: unknown }).fingerprint !== fingerprint)
    throw new Error("Alpaca canary runRef input conflict");
  await persistGoalWorkItem(db, { agentId, entityId, goalId, now });
  return { agentId, entityId, workItemId: goalId };
}

type Scope = Awaited<ReturnType<typeof ensureWorkItem>>;
type CanaryRequest = Parameters<typeof runAlpacaPaperCanary>[0];
type StoredIntent = {
  readonly id: string;
  readonly status: string;
  readonly effectKey: string;
  readonly inputRefs: unknown;
};

async function blockReconciliation(db: Database, intentId: string) {
  await db.update(effectIntentsTable).set({
    status: "reconciliation_blocked",
    leaseOwner: null,
    leaseExpiresAt: null,
  }).where(eq(effectIntentsTable.id, intentId));
}

async function executeStoredIntent(
  db: Database,
  storedIntent: StoredIntent,
  provider: ReturnType<typeof createLocalAlpacaCliProvider>,
) {
  const stored = storedIntent.inputRefs as { canaryRequest?: unknown; expiresAt?: unknown };
  if (!stored.canaryRequest || typeof stored.expiresAt !== "string")
    throw new Error("Alpaca canary stored intent is incomplete");
  const canaryRequest = stored.canaryRequest as CanaryRequest;
  const sealed = sealAlpacaPaperCanary(canaryRequest);
  try {
    const order = await provider.findOrderByClientId(sealed.clientOrderId);
    if (order) {
      const result = reconcileAlpacaPaperCanaryReadback(canaryRequest, order);
      await db.update(effectIntentsTable).set({
        status: "applied",
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(eq(effectIntentsTable.id, storedIntent.id));
      return result;
    }
  } catch {
    await blockReconciliation(db, storedIntent.id);
    throw new Error("Alpaca canary broker state is unknown; reconciliation breaker is open");
  }
  if (storedIntent.status !== "planned") {
    await blockReconciliation(db, storedIntent.id);
    throw new Error("Alpaca canary broker order is absent after effect start; reconciliation breaker is open");
  }
  const now = new Date();
  if (now.getTime() > Date.parse(stored.expiresAt)) {
    await blockReconciliation(db, storedIntent.id);
    throw new Error("Alpaca canary sealed plan expired before effect; reconciliation breaker is open");
  }
  const leaseOwner = randomUUID();
  const claimed = await db.update(effectIntentsTable).set({
    status: "running",
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
  }).where(and(
    eq(effectIntentsTable.id, storedIntent.id),
    eq(effectIntentsTable.status, "planned"),
  )).returning({ id: effectIntentsTable.id });
  if (claimed.length !== 1) throw new Error("Alpaca canary effect is already claimed");
  let result;
  try {
    result = await runAlpacaPaperCanary(canaryRequest, provider);
  } catch {
    await blockReconciliation(db, storedIntent.id);
    throw new Error("Alpaca canary effect acknowledgement is unknown; reconciliation breaker is open");
  }
  await db.update(effectIntentsTable).set({
    status: "applied",
    leaseOwner: null,
    leaseExpiresAt: null,
  }).where(eq(effectIntentsTable.id, claimed[0]!.id));
  return result;
}

async function persistOutcome(db: Database, scope: Scope, intent: StoredIntent, result: Awaited<ReturnType<typeof runAlpacaPaperCanary>>) {
  await db.insert(outcomeReceiptsTable).values({
    agentId: scope.agentId,
    entityId: scope.entityId,
    effectIntentId: intent.id,
    attempt: 0,
    outcome: result.receipt.outcome,
    effectKey: intent.effectKey,
    receipt: result.receipt,
  }).onConflictDoNothing();
}

function reconcileCampaignSnapshot(
  snapshot: AlpacaCampaignSnapshot,
  expectedSymbols: readonly string[],
) {
  const expected = new Set(expectedSymbols);
  if (snapshot.positions.some(({ symbol }) => !expected.has(symbol)) ||
      snapshot.fills.some(({ symbol }) => !expected.has(symbol)))
    throw new Error("Alpaca campaign contains an unknown instrument; reconciliation breaker is open");
  const netFilled = new Map(expectedSymbols.map((symbol) => [symbol, 0]));
  let fillCashFlowUsd = 0;
  for (const fill of snapshot.fills) {
    if (!(fill.quantity > 0) || !(fill.price > 0))
      throw new Error("Alpaca campaign fill is invalid; reconciliation breaker is open");
    const sign = fill.side === "buy" ? 1 : -1;
    netFilled.set(fill.symbol, (netFilled.get(fill.symbol) ?? 0) + sign * fill.quantity);
    fillCashFlowUsd += -sign * fill.quantity * fill.price * 100;
  }
  const positions = new Map(snapshot.positions.map((position) => [position.symbol, position]));
  for (const symbol of expectedSymbols) {
    const position = positions.get(symbol);
    const officialQuantity = position?.quantity ?? 0;
    if (Math.abs((netFilled.get(symbol) ?? 0) - officialQuantity) > 1e-9)
      throw new Error("Alpaca campaign fill/position quantity mismatch; reconciliation breaker is open");
    if (position && ((position.side === "long") !== (position.quantity > 0)))
      throw new Error("Alpaca campaign position side mismatch; reconciliation breaker is open");
  }
  const unrealizedPnlUsd = snapshot.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const closed = snapshot.positions.length === 0 && snapshot.fills.length > 0;
  return Object.freeze({
    paper: true as const,
    status: closed ? "CLOSED" as const : "OPEN" as const,
    equityUsd: snapshot.equity,
    cashUsd: snapshot.cash,
    fillCount: snapshot.fills.length,
    positionCount: snapshot.positions.length,
    fillCashFlowUsd: Math.round(fillCashFlowUsd * 100) / 100,
    unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
    ...(closed ? { realizedPnlUsd: Math.round(fillCashFlowUsd * 100) / 100 } : {}),
    observedAt: snapshot.observedAt,
  });
}

async function persistCampaignSnapshot(
  db: Database,
  scope: Scope,
  provider: ReturnType<typeof createLocalAlpacaCliProvider>,
  expectedSymbols: readonly string[],
) {
  const projection = reconcileCampaignSnapshot(await provider.readCampaignSnapshot(), expectedSymbols);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ ...projection, observedAt: undefined }))
    .digest("hex");
  const effectKey = `alpaca-paper-campaign-observation:${fingerprint}`;
  await db.insert(effectIntentsTable).values({
    agentId: scope.agentId,
    entityId: scope.entityId,
    workItemId: scope.workItemId,
    effectClass: "broker.paper.reconcile",
    effectKey,
    inputRefs: { provider: "alpaca-cli", paper: true, expectedSymbols },
    status: "applied",
  }).onConflictDoNothing();
  const intent = (await db.select({ id: effectIntentsTable.id }).from(effectIntentsTable).where(and(
    eq(effectIntentsTable.agentId, scope.agentId),
    eq(effectIntentsTable.entityId, scope.entityId),
    eq(effectIntentsTable.effectKey, effectKey),
  )).limit(1))[0];
  if (!intent) throw new Error("Alpaca campaign observation intent persistence failed");
  await db.insert(outcomeReceiptsTable).values({
    agentId: scope.agentId,
    entityId: scope.entityId,
    effectIntentId: intent.id,
    attempt: 0,
    outcome: "observed",
    effectKey,
    receipt: projection,
  }).onConflictDoNothing();
  return projection;
}

export async function runAlpacaCanaryPass(
  runtime: IAgentRuntime,
  request: AlpacaCanaryPassRequest,
) {
  if (!request.runRef || request.runRef.length > 128 || request.candidates.length < 1 || request.candidates.length > 4)
    throw new Error("Alpaca canary pass request is invalid");
  const now = new Date();
  const candidates = request.candidates.map((candidate) => validateCandidate(candidate, now));
  if (new Set(candidates.map(({ candidateRef }) => candidateRef)).size !== candidates.length)
    throw new Error("Alpaca canary candidate refs must be unique");
  const db = runtime.db as unknown as Database | undefined;
  if (!db || typeof db.transaction !== "function") throw new Error("Alpaca canary requires plugin-sql runtime.db");
  const fingerprint = requestFingerprint(request.candidates);
  const scope = await ensureWorkItem(runtime, db, request.runRef, fingerprint, now);
  const provider = createLocalAlpacaCliProvider();
  const existingIntent = (await db.select({
    id: effectIntentsTable.id,
    status: effectIntentsTable.status,
    effectKey: effectIntentsTable.effectKey,
    inputRefs: effectIntentsTable.inputRefs,
  }).from(effectIntentsTable).where(and(
    eq(effectIntentsTable.agentId, scope.agentId),
    eq(effectIntentsTable.entityId, scope.entityId),
    eq(effectIntentsTable.workItemId, scope.workItemId),
    eq(effectIntentsTable.effectClass, "broker.paper.order"),
  )).limit(1))[0];
  if (existingIntent) {
    const result = await executeStoredIntent(db, existingIntent, provider);
    await persistOutcome(db, scope, existingIntent, result);
    const campaign = await persistCampaignSnapshot(
      db,
      scope,
      provider,
      candidates.flatMap(({ buySymbol, sellSymbol }) => [buySymbol, sellSymbol]),
    );
    return Object.freeze({ status: "ORDER_VERIFIED", result, campaign });
  }
  const observedAccount = await provider.observe("SPY");
  if (observedAccount.positionsCount !== 0 || observedAccount.openOrdersCount !== 0)
    throw new Error("Alpaca canary requires an empty paper account");
  const snapshots = await provider.readOptionSnapshots(candidates.flatMap(({ buySymbol, sellSymbol }) => [buySymbol, sellSymbol]));
  const bySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  const offered = candidates.map((candidate) => {
    const buy = bySymbol.get(candidate.buySymbol);
    const sell = bySymbol.get(candidate.sellSymbol);
    if (!buy || !sell) throw new Error("Alpaca canary snapshot is incomplete");
    const bid = buy.bid - sell.ask;
    const ask = buy.ask - sell.bid;
    if (!(bid > 0 && ask >= bid)) throw new Error("Alpaca canary spread quote is invalid");
    const netDebit = Math.round(ask * 100) / 100;
    return { ...candidate, buy, sell, bid, ask, netDebit, maxLossUsd: netDebit * 100 };
  });
  const evidenceRefs = offered.flatMap(({ buySymbol, sellSymbol }) => [
    `alpaca-cli://option-snapshot/${buySymbol}`,
    `alpaca-cli://option-snapshot/${sellSymbol}`,
  ]);
  const decision = await decideAndPersistAlpacaTrade(runtime, db, {
    ...scope,
    objective: "Choose at most one minimum-risk SPY debit spread paper canary, or NO_TRADE.",
    observation: { account: observedAccount, candidates: offered.map(({ buy, sell, ...candidate }) => ({ ...candidate, buy, sell })) },
    evidenceRefs,
    candidateRefs: offered.map(({ candidateRef }) => candidateRef),
  });
  if (decision.status === "NO_TRADE") return Object.freeze({ status: "NO_TRADE", decision });
  const selected = offered.find(({ candidateRef }) => candidateRef === decision.candidateRef);
  if (!selected) throw new Error("Alpaca canary selected candidate is unavailable");
  const account = await provider.observe("SPY");
  if (account.positionsCount !== 0 || account.openOrdersCount !== 0)
    throw new Error("Alpaca canary account changed before effect");
  const quoteAtMs = Math.min(Date.parse(selected.buy.quoteAt), Date.parse(selected.sell.quoteAt));
  const risk = evaluateAlpacaRisk({
    nowMs: Date.now(),
    regularSessionOpen: account.regularSessionOpen,
    reconciliationHealthy: account.positionsCount === 0 && account.openOrdersCount === 0,
    decision,
    structure: selected.structure,
    quantity: 1,
    netDebitPerShare: selected.netDebit,
    equityUsd: account.equity,
    cashUsd: account.cash,
    highWaterEquityUsd: Math.max(100_000, account.equity, account.lastEquity),
    dailyPnlUsd: account.equity - account.lastEquity,
    openMaxLossUsd: 0,
    borrowedValueUsd: account.positionsCount === 0 ? 0 : 1,
    optionsLevel: account.optionsLevel,
    positionsCount: account.positionsCount,
    openOrdersCount: account.openOrdersCount,
    quoteBid: selected.bid,
    quoteAsk: selected.ask,
    quoteAtMs,
    greeksAtMs: Math.min(Date.parse(selected.buy.observedAt), Date.parse(selected.sell.observedAt)),
    dte: selected.dte,
  });
  if (!risk.allowed) return Object.freeze({ status: "RISK_REJECTED", decision, risk });
  const canaryRequest = {
    workItemRef: `life-manager-work-item://${scope.workItemId}`,
    decisionReceiptRef: `life-manager-decision://${scope.workItemId}`,
    riskReceiptRef: `life-manager-risk://${scope.workItemId}`,
    risk,
    order: {
      paper: true as const,
      quantity: 1,
      limitPrice: selected.netDebit,
      legs: [
        { symbol: selected.buySymbol, ratioQuantity: 1, positionIntent: "buy_to_open" as const },
        { symbol: selected.sellSymbol, ratioQuantity: 1, positionIntent: "sell_to_open" as const },
      ],
    },
  };
  const intent = sealAlpacaPaperCanary(canaryRequest);
  await db.insert(effectIntentsTable).values({
    agentId: scope.agentId,
    entityId: scope.entityId,
    workItemId: scope.workItemId,
    effectClass: "broker.paper.order",
    effectKey: intent.effectKey,
    inputRefs: { ...intent.inputRefs, canaryRequest, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    status: "planned",
  }).onConflictDoNothing();
  const storedIntent = (await db.select({
    id: effectIntentsTable.id,
    status: effectIntentsTable.status,
    effectKey: effectIntentsTable.effectKey,
    inputRefs: effectIntentsTable.inputRefs,
  }).from(effectIntentsTable).where(and(
    eq(effectIntentsTable.agentId, scope.agentId),
    eq(effectIntentsTable.entityId, scope.entityId),
    eq(effectIntentsTable.workItemId, scope.workItemId),
    eq(effectIntentsTable.effectClass, "broker.paper.order"),
  )).limit(1))[0];
  if (!storedIntent) throw new Error("Alpaca canary effect intent persistence failed");
  const result = await executeStoredIntent(db, storedIntent, provider);
  await persistOutcome(db, scope, storedIntent, result);
  return Object.freeze({ status: "ORDER_VERIFIED", decision, risk, result });
}
