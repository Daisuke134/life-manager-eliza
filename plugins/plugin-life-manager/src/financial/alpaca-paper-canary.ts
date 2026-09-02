import { createHash } from "node:crypto";
import type { AppliedEffectReceipt, CommittedEffectReceipt } from "@elizaos/core";
import { runEffectReceiptKernel, type EffectReceiptKernelResult } from "../effect-receipt-kernel.js";
import type { AlpacaCliProvider, AlpacaDefinedRiskOrderRequest, AlpacaPaperOrderReadback, AlpacaSpotOrderRequest } from "./alpaca-local-adapter.js";
import type { AlpacaRiskGateResult } from "./alpaca-risk-gate.js";

export interface AlpacaPaperCanaryRequest {
  readonly workItemRef: string;
  readonly decisionReceiptRef: string;
  readonly riskReceiptRef: string;
  readonly risk: AlpacaRiskGateResult;
  readonly order: Omit<AlpacaDefinedRiskOrderRequest, "clientOrderId">;
}

export interface AlpacaPaperSpotRequest {
  readonly workItemRef: string;
  readonly decisionReceiptRef: string;
  readonly riskReceiptRef: string;
  readonly risk: { readonly allowed: boolean; readonly aggregateMaxLossUsd: number; readonly reasons: readonly string[] };
  readonly order: Omit<AlpacaSpotOrderRequest, "clientOrderId">;
}

const acceptedStatuses = new Set(["accepted", "pending_new", "new", "partially_filled", "filled", "held", "pending_replace"]);

function boundedRef(value: string, name: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`Alpaca canary ${name} is invalid`);
  return value;
}

export function sealAlpacaPaperCanary(request: AlpacaPaperCanaryRequest) {
  if (request.order.paper !== true || request.risk.allowed !== true || request.risk.reasons.length)
    throw new Error("Alpaca canary requires an allowed paper risk receipt");
  const workItemRef = boundedRef(request.workItemRef, "work item ref");
  const decisionReceiptRef = boundedRef(request.decisionReceiptRef, "decision receipt ref");
  const riskReceiptRef = boundedRef(request.riskReceiptRef, "risk receipt ref");
  const payload = JSON.stringify({
    workItemRef,
    decisionReceiptRef,
    riskReceiptRef,
    maxLossUsd: request.risk.calculatedMaxLossUsd,
    order: request.order,
  });
  const clientOrderId = `lm-a08-${createHash("sha256").update(payload).digest("hex").slice(0, 40)}`;
  return Object.freeze({
    clientOrderId,
    effectKey: `alpaca-paper-order:${clientOrderId}`,
    order: Object.freeze({ ...request.order, clientOrderId }),
    inputRefs: Object.freeze({ workItemRef, decisionReceiptRef, riskReceiptRef }),
  });
}

export function sealAlpacaPaperSpotOrder(request: AlpacaPaperSpotRequest) {
  if (request.order.paper !== true || request.risk.allowed !== true || request.risk.reasons.length)
    throw new Error("Alpaca spot order requires an allowed paper portfolio risk receipt");
  const workItemRef = boundedRef(request.workItemRef, "work item ref");
  const decisionReceiptRef = boundedRef(request.decisionReceiptRef, "decision receipt ref");
  const riskReceiptRef = boundedRef(request.riskReceiptRef, "risk receipt ref");
  const payload = JSON.stringify({
    workItemRef, decisionReceiptRef, riskReceiptRef,
    aggregateMaxLossUsd: request.risk.aggregateMaxLossUsd,
    order: request.order,
  });
  const clientOrderId = `lm-a11-${createHash("sha256").update(payload).digest("hex").slice(0, 40)}`;
  return Object.freeze({
    clientOrderId,
    effectKey: `alpaca-paper-order:${clientOrderId}`,
    order: Object.freeze({ ...request.order, clientOrderId }),
    inputRefs: Object.freeze({ workItemRef, decisionReceiptRef, riskReceiptRef }),
  });
}

function receipt(order: AlpacaPaperOrderReadback, effectKey: string, replayed: true): CommittedEffectReceipt;
function receipt(order: AlpacaPaperOrderReadback, effectKey: string, replayed: false): AppliedEffectReceipt;
function receipt(order: AlpacaPaperOrderReadback, effectKey: string, replayed: boolean): CommittedEffectReceipt | AppliedEffectReceipt {
  if (!acceptedStatuses.has(order.status)) throw new Error("Alpaca paper order was not accepted");
  const shared = {
    receiptId: order.id,
    operation: "alpaca.paper.options.order.submit",
    resource: { kind: "alpaca.paper.order", id: order.clientOrderId },
    artifacts: [],
    observedAt: order.submittedAt,
  };
  return replayed
    ? { ...shared, idempotency: { key: effectKey, replayed: true }, outcome: "noop", reason: "Official Alpaca CLI readback already contains the order" }
    : { ...shared, idempotency: { key: effectKey, replayed: false }, outcome: "applied", commit: { kind: "provider_accepted", id: order.id, committedAt: order.submittedAt } };
}

export async function runAlpacaPaperCanary(
  request: AlpacaPaperCanaryRequest,
  provider: AlpacaCliProvider,
): Promise<EffectReceiptKernelResult> {
  const intent = sealAlpacaPaperCanary(request);
  return runEffectReceiptKernel(
    {
      effectKey: intent.effectKey,
      operation: "alpaca.paper.options.order.submit",
      resource: { kind: "alpaca.paper.order", id: intent.clientOrderId },
      inputRefs: intent.inputRefs,
    },
    {
      inspect: async () => {
        const order = await provider.findOrderByClientId(intent.clientOrderId);
        return order ? { state: "present" as const, receipt: order } : { state: "absent" as const };
      },
      executeOnce: () => provider.submitDefinedRiskOrder(intent.order),
      verifyReceipt: (raw, _effect, replayed) => replayed
        ? receipt(raw as AlpacaPaperOrderReadback, intent.effectKey, true)
        : receipt(raw as AlpacaPaperOrderReadback, intent.effectKey, false),
    },
  );
}

export function reconcileAlpacaPaperCanaryReadback(
  request: AlpacaPaperCanaryRequest,
  order: AlpacaPaperOrderReadback,
): EffectReceiptKernelResult {
  const intent = sealAlpacaPaperCanary(request);
  if (order.clientOrderId !== intent.clientOrderId)
    throw new Error("Alpaca paper order readback does not match the sealed intent");
  return {
    effect_started: false,
    replayed: true,
    receipt: receipt(order, intent.effectKey, true),
  };
}

function spotReceipt(order: AlpacaPaperOrderReadback, effectKey: string, replayed: boolean): CommittedEffectReceipt | AppliedEffectReceipt {
  if (!acceptedStatuses.has(order.status)) throw new Error("Alpaca paper spot order was not accepted");
  const shared = {
    receiptId: order.id,
    operation: "alpaca.paper.spot.order.submit",
    resource: { kind: "alpaca.paper.order", id: order.clientOrderId },
    artifacts: [],
    observedAt: order.submittedAt,
  };
  return replayed
    ? { ...shared, idempotency: { key: effectKey, replayed: true }, outcome: "noop", reason: "Official Alpaca CLI readback already contains the spot order" }
    : { ...shared, idempotency: { key: effectKey, replayed: false }, outcome: "applied", commit: { kind: "provider_accepted", id: order.id, committedAt: order.submittedAt } };
}

export async function runAlpacaPaperSpotOrder(request: AlpacaPaperSpotRequest, provider: AlpacaCliProvider) {
  const intent = sealAlpacaPaperSpotOrder(request);
  return runEffectReceiptKernel(
    {
      effectKey: intent.effectKey,
      operation: "alpaca.paper.spot.order.submit",
      resource: { kind: "alpaca.paper.order", id: intent.clientOrderId },
      inputRefs: intent.inputRefs,
    },
    {
      inspect: async () => {
        const order = await provider.findOrderByClientId(intent.clientOrderId);
        return order ? { state: "present" as const, receipt: order } : { state: "absent" as const };
      },
      executeOnce: () => provider.submitSpotOrder(intent.order),
      verifyReceipt: (raw, _effect, replayed) => spotReceipt(raw as AlpacaPaperOrderReadback, intent.effectKey, replayed),
    },
  );
}

export function reconcileAlpacaPaperSpotReadback(request: AlpacaPaperSpotRequest, order: AlpacaPaperOrderReadback): EffectReceiptKernelResult {
  const intent = sealAlpacaPaperSpotOrder(request);
  if (order.clientOrderId !== intent.clientOrderId)
    throw new Error("Alpaca paper spot readback does not match the sealed intent");
  return { effect_started: false, replayed: true, receipt: spotReceipt(order, intent.effectKey, true) as CommittedEffectReceipt };
}
