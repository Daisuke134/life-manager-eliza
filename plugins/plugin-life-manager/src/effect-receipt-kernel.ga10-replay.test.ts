/**
 * ELZ-L03: drive the effect kernel from the recorded GA-10 observations for
 * Lancers proposal 27861812 and require the historical terminal state back.
 *
 * C08 proved the kernel against synthetic fixtures. This replays the real
 * chain — absent, one execution, present, then a replay that must not execute —
 * with no provider call anywhere: every input comes off disk.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type EffectReceiptKernelInspection,
  type EffectReceiptKernelRequest,
  runEffectReceiptKernel,
} from "./effect-receipt-kernel";

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "__fixtures__", "ga10-lancers-27861812.json"),
    "utf8",
  ),
) as {
  opportunity_external_id: string;
  application_external_id: string;
  job: { capability: string; effect_key: string; input_refs: Record<string, string> };
  pre_effect: { official_history_state: string; verified_count_before: number };
  post_effect: { state: string; verified_count: number };
  receipt: { idempotency_key: string; observed_at: string };
  terminal_state: {
    replayed: boolean;
    effect_started: boolean;
    execute_once_count: number;
    verified_count_after_replay: number;
  };
};

const REQUEST: EffectReceiptKernelRequest = {
  effectKey: FIXTURE.job.effect_key,
  operation: FIXTURE.job.capability,
  resource: { kind: "marketplace.opportunity", id: FIXTURE.opportunity_external_id },
  inputRefs: FIXTURE.job.input_refs,
};

function receiptFor(replayed: boolean) {
  const shared = {
    receiptId: FIXTURE.receipt.idempotency_key,
    operation: REQUEST.operation,
    resource: REQUEST.resource,
    artifacts: [],
    idempotency: { key: REQUEST.effectKey, replayed },
    observedAt: FIXTURE.receipt.observed_at,
  };
  return replayed
    ? { ...shared, outcome: "noop", reason: "Official readback already present" }
    : {
        ...shared,
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: FIXTURE.application_external_id,
          committedAt: FIXTURE.receipt.observed_at,
        },
      };
}

/** Counts executions, and refuses the ones the fixture says never happened. */
function harness(states: EffectReceiptKernelInspection["state"][]) {
  const remaining = [...states];
  let executeCount = 0;
  return {
    get executeCount() {
      return executeCount;
    },
    deps: {
      inspect: (): EffectReceiptKernelInspection => {
        const state = remaining.shift();
        if (state === "present") return { state, receipt: receiptFor(executeCount === 0) };
        if (state === "absent") return { state };
        throw new Error("fixture exhausted");
      },
      executeOnce: () => {
        executeCount += 1;
        return undefined;
      },
      verifyReceipt: (raw: unknown) => raw,
    },
  };
}

describe("GA-10 replay through the effect kernel", () => {
  it("re-applies nothing when the recorded readback already shows the proposal", async () => {
    // The replay leg alone: pre-readback is present, so executeOnce must never
    // be reached. Any call is a failure, not a tally.
    const executed: string[] = [];
    const result = await runEffectReceiptKernel(REQUEST, {
      inspect: () => ({ state: "present", receipt: receiptFor(true) }),
      executeOnce: () => {
        executed.push(REQUEST.effectKey);
        throw new Error("replay reached the provider");
      },
      verifyReceipt: (raw: unknown) => raw,
    });

    expect(executed).toEqual([]);
    expect(result.effect_started).toBe(FIXTURE.terminal_state.effect_started);
    expect(result.replayed).toBe(FIXTURE.terminal_state.replayed);
    expect(result.receipt.idempotency.key).toBe(FIXTURE.job.effect_key);
    expect(result.receipt.idempotency.replayed).toBe(true);
    expect(result.receipt.outcome).toBe("noop");
  });

  it("executes once on the absent leg and not again on the replay", async () => {
    const fresh = harness(["absent", "present"]);
    const first = await runEffectReceiptKernel(REQUEST, fresh.deps);

    expect(fresh.executeCount).toBe(1);
    expect(first.effect_started).toBe(true);
    expect(first.replayed).toBe(false);
    expect(first.receipt.outcome).toBe("applied");

    const replay = harness(["present"]);
    const second = await runEffectReceiptKernel(REQUEST, replay.deps);

    expect(replay.executeCount).toBe(FIXTURE.terminal_state.execute_once_count);
    expect(second.effect_started).toBe(false);
    expect(second.replayed).toBe(true);
  });

  it("commits against the proposal the buyer actually received", async () => {
    const fresh = harness(["absent", "present"]);
    const result = await runEffectReceiptKernel(REQUEST, fresh.deps);

    // The one execution has to land on proposal 27861812, not merely on some
    // applied receipt — and the counts say it added exactly one.
    expect(result.effect_started).toBe(true);
    expect((result.receipt as { commit: { id: string } }).commit.id).toBe(
      FIXTURE.application_external_id,
    );
    expect(FIXTURE.post_effect.verified_count - FIXTURE.pre_effect.verified_count_before).toBe(
      fresh.executeCount,
    );
    expect(FIXTURE.terminal_state.verified_count_after_replay).toBe(
      FIXTURE.post_effect.verified_count,
    );
  });
});
