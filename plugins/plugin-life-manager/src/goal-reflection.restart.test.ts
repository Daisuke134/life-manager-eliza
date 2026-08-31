/**
 * ELZ-C09-03: same on-disk PGlite reopened in a SEPARATE OS process proves
 * identical GoalReflection readback. Process 1 (child process A) applies the
 * real production migration, writes one tenant-scoped Goal chain with a
 * success case, a failure case, and cost/currency receipts, reads it back
 * through the real readGoalReflection service, then closes. Process 2 (child
 * process B, a brand-new `bun` process) re-opens the same on-disk dir with
 * zero writes and must observe the identical hash/count/refs, proving no
 * writer/lock survives process 1's close.
 *
 * No model/provider/browser/marketplace/payment effect: pure PGlite I/O.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WORKER = path.join(import.meta.dirname, "goal-reflection.restart.worker.ts");
const RECEIPT_DIR = path.join(homedir(), ".local", "state", "life-manager", "eliza-atoms");
const RECEIPT_PATH = path.join(RECEIPT_DIR, "reflect-restart-receipt.json");

interface WorkerResult {
  mode: "write" | "read";
  pid: number;
  hash: string;
  counts: Record<string, number>;
  reflection: unknown;
}

function runWorker(mode: "write" | "read", dataDir: string, ids: string[]): WorkerResult {
  const stdout = execFileSync("bun", ["run", WORKER, mode, dataDir, ...ids], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout) as WorkerResult;
}

function writeReceipt(payload: Record<string, unknown>): void {
  mkdirSync(RECEIPT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RECEIPT_DIR, 0o700);
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(RECEIPT_PATH, 0o600);
}

describe("Goal reflection restart across separate processes", () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens the same PGlite dir in a fresh process and reads an identical reflection", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "elz-c09-03-restart-"));
    tempDirectories.push(dataDir);
    const agentId = "00000000-0000-4000-8000-000000000101";
    const entityId = "00000000-0000-4000-8000-000000000102";
    const goalId = "00000000-0000-4000-8000-000000000103";
    const ids = [agentId, entityId, goalId];

    // Process 1: fresh `bun` child process. Writes the fixture, reads it
    // back, then exits — closing (and releasing) the PGlite data dir.
    const first = runWorker("write", dataDir, ids);
    expect(first.pid).not.toBe(process.pid);
    expect(first.counts).toEqual({
      goals: 1,
      plan_graphs: 1,
      work_items: 1,
      effect_intents: 2,
      outcome_receipts: 2,
      economic_receipts: 2,
    });

    // Process 2: a SEPARATE fresh `bun` child process re-opens the same
    // on-disk dir. It performs zero writes (the worker's "read" mode never
    // calls INSERT/UPDATE/DELETE). If process 1 had leaked its writer lock,
    // this open would throw or hang instead of succeeding immediately.
    const second = runWorker("read", dataDir, ids);
    expect(second.pid).not.toBe(process.pid);
    expect(second.pid).not.toBe(first.pid);

    // Identical hash, identical counts (proves process 2 added zero rows),
    // identical reflection shape/refs.
    expect(second.hash).toBe(first.hash);
    expect(second.counts).toEqual(first.counts);
    expect(second.reflection).toEqual(first.reflection);

    const receipt = {
      status: "PASS",
      atom: "ELZ-C09-03",
      generatedAt: new Date().toISOString(),
      dataDir,
      hash: first.hash,
      counts: first.counts,
      processOne: { pid: first.pid, mode: first.mode },
      processTwo: { pid: second.pid, mode: second.mode },
    };
    writeReceipt(receipt);

    expect(receipt.status).toBe("PASS");
    // Two child `bun` processes each boot PGlite; a cold WASM compile runs
    // past vitest's 5s default.
  }, 120_000);
});
