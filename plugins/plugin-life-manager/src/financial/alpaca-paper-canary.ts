import { createHash } from "node:crypto";
import { runEffectReceiptKernel, type EffectReceiptKernelResult } from "../effect-receipt-kernel.js";
import type { AlpacaCliProvider, AlpacaDefinedRiskOrderRequest, AlpacaPaperOrderReadback } from "./alpaca-local-adapter.js";
import type { AlpacaRiskGateResult } from "./alpaca-risk-gate.js";

export interface AlpacaPaperCanaryRequest {
  readonly workItemRef: string;
  readonly decisionReceiptRef: string;
  readonly riskReceiptRef: string;
  readonly risk: AlpacaRiskGateResult;
  readonly order: Omit<AlpacaDefinedRiskOrderRequest, "clientOrderId">;
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

function receipt(order: AlpacaPaperOrderReadback, effectKey: string, replayed: boolean) {
  if (!acceptedStatuses.has(order.status)) throw new Error("Alpaca paper order was not accepted");
  const shared = {
    receiptId: order.id,
    operation: "alpaca.paper.options.order.submit",
    resource: { kind: "alpaca.paper.order", id: order.clientOrderId },
    artifacts: [],
    idempotency: { key: effectKey, replayed },
    observedAt: order.submittedAt,
  };
  return replayed
    ? { ...shared, outcome: "noop", reason: "Official Alpaca CLI readback already contains the order" }
    : { ...shared, outcome: "applied", commit: { kind: "provider_accepted", id: order.id, committedAt: order.submittedAt } };
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
      verifyReceipt: (raw, _effect, replayed) => receipt(raw as AlpacaPaperOrderReadback, intent.effectKey, replayed),
    },
  );
}
