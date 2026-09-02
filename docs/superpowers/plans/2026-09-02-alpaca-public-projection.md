# Alpaca Public Projection Implementation Plan

> **For agentic workers:** Execute inline; do not add a scheduler, broker mutation, authentication dependency, or review gate.

**Goal:** Expose one logged-out, read-only, redacted JSON projection for the Alpaca paper campaign so the later public demo and static fixture consume identical data.

**Architecture:** A pure whitelist projector converts official CLI campaign state plus persisted Life Manager decisions/effects/outcomes into public JSON. One existing plugin route reads those sources and returns the projection. No credential, account ID, raw input reference, model prompt, or mutation method crosses the boundary.

**Tech Stack:** TypeScript, Eliza plugin routes, Drizzle, existing Alpaca CLI read adapter, Vitest.

## Global Constraints

- Paper mode only; `paper: true` is constant.
- Alpaca CLI remains the only broker authority; this endpoint performs reads only.
- The endpoint exposes no account ID, API key, secret, credential reference, or order-placement surface.
- No new package, DB table, scheduler, or frontend framework.

---

### Task 1: Pure redacted projection

**Files:**
- Create: `plugins/plugin-life-manager/src/financial/alpaca-public-projection.ts`
- Test: `plugins/plugin-life-manager/src/financial/alpaca-public-projection.test.ts`

**Produces:** `buildAlpacaPublicProjection(input)` returning paper status, equity/cash/P&L, positions, fills, latest decision, gate summary, effect timeline, and reconciliation timestamp from an explicit allowlist.

- [x] Build the immutable whitelist projection; compute unrealised P&L from positions and total P&L from `$100,000` starting equity.
- [x] Verify serialized output contains no supplied private sentinel and preserves the judge-visible campaign lifecycle.

### Task 2: Read-only route

**Files:**
- Modify: `plugins/plugin-life-manager/src/financial/alpaca-paper-account-routes.ts`

**Consumes:** `buildAlpacaPublicProjection(input)`.

- [x] Add `GET /api/life-manager/alpaca/public`.
- [x] Read the official CLI campaign snapshot and latest scoped decision/effect/outcome rows.
- [x] Return `200` projection or `503` with a generic read-only error; never return raw provider/model output.

### Task 3: Focused verification and integration

- [x] Run `bun run --cwd plugins/plugin-life-manager typecheck`.
- [x] Run `bun run --cwd plugins/plugin-life-manager test -- alpaca-public-projection.test.ts`.
- [x] Run `bun run --cwd plugins/plugin-life-manager build` and `git diff --check`.
- [x] Commit, push, merge to `main`, then update the Life Manager spec without advancing A12 to done until a logged-out hosted URL is read back.
