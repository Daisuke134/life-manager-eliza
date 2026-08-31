/**
 * ELZ-L04: the resolver must open only what Dais standing-authorized, and must
 * close on everything else. Default-deny is the property under test, so each
 * case removes exactly one thing and expects the human ceremony back.
 */
import { PROVIDER_INTEGRATION_CONTRACT_VERSION } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  authorizeLifeManagerCapability,
  LifeManagerHumanCeremonyRequiredError,
  type LifeManagerAuthorizationRef,
} from "./capability-authorization.ts";
import {
  createLifeManagerPolicyResolver,
  LifeManagerAuthorizationAlreadySpentError,
  LifeManagerUnknownAuthorizationRefError,
  type LifeManagerAuthorizationEnvelope,
  type LifeManagerStandingPolicy,
} from "./authorization-resolver.ts";

const VERSION = PROVIDER_INTEGRATION_CONTRACT_VERSION;
const CAPABILITY_ID = "marketplace.application";
const REF = "life-manager-authorization://lancers-5593059" as LifeManagerAuthorizationRef;
const BOUND_AT = "2026-08-31T12:00:00.000Z";
const NOW = Date.parse("2026-08-31T12:00:10.000Z");

const ENVELOPE: LifeManagerAuthorizationEnvelope = {
  requestId: "request-lancers-application-1",
  operation: "marketplace.application.submit",
  riskLevel: "R2",
  inputDigest: "b".repeat(64),
  accountId: null,
  boundAt: BOUND_AT,
  account: {
    contractVersion: VERSION,
    accountId: "opaque-account-1",
    providerId: "opaque-provider-1",
    mode: "cloud",
    status: "connected",
    displayName: "Private account",
    capabilities: [
      { capabilityId: CAPABILITY_ID, riskLevel: "R2", status: "available" },
    ],
    lastUsedAt: null,
  },
};

const STANDING: LifeManagerStandingPolicy = {
  capability_id: CAPABILITY_ID,
  outcome: "allowed",
  platform: "lancers",
};

function resolver(overrides: {
  envelope?: LifeManagerAuthorizationEnvelope | undefined;
  standing?: LifeManagerStandingPolicy | undefined;
} = {}) {
  return createLifeManagerPolicyResolver({
    loadEnvelope: () =>
      "envelope" in overrides ? overrides.envelope : ENVELOPE,
    loadStandingPolicy: () =>
      "standing" in overrides ? overrides.standing : STANDING,
    now: () => NOW,
  });
}

const REQUEST = { capabilityId: CAPABILITY_ID, authorizationRef: REF };

describe("Life Manager standing authorization resolver", () => {
  it("dispatches when Dais standing-authorized the capability", async () => {
    const authorized = await authorizeLifeManagerCapability(
      REQUEST,
      resolver(),
      NOW,
    );

    expect(authorized.capabilityId).toBe(CAPABILITY_ID);
    expect(authorized.requestDigest).toHaveLength(64);
  });

  it("spends the authorization once, so a replay of the same ref is refused", async () => {
    const shared = resolver();
    await authorizeLifeManagerCapability(REQUEST, shared, NOW);

    // Same ref, same coordinator: the consume-once core must not hand out a
    // second dispatch for one decision.
    await expect(
      authorizeLifeManagerCapability(REQUEST, shared, NOW),
    ).rejects.toBeInstanceOf(LifeManagerAuthorizationAlreadySpentError);
  });

  it("asks for a human when no standing policy exists", async () => {
    await expect(
      authorizeLifeManagerCapability(REQUEST, resolver({ standing: undefined }), NOW),
    ).rejects.toBeInstanceOf(LifeManagerHumanCeremonyRequiredError);
  });

  it("asks for a human when the standing policy is not an allow", async () => {
    await expect(
      authorizeLifeManagerCapability(
        REQUEST,
        resolver({ standing: { ...STANDING, outcome: "denied" } }),
        NOW,
      ),
    ).rejects.toBeInstanceOf(LifeManagerHumanCeremonyRequiredError);
  });

  it("asks for a human when the policy allows some other capability", async () => {
    await expect(
      authorizeLifeManagerCapability(
        REQUEST,
        resolver({ standing: { ...STANDING, capability_id: "marketplace.delivery" } }),
        NOW,
      ),
    ).rejects.toBeInstanceOf(LifeManagerHumanCeremonyRequiredError);
  });

  it("refuses a ref it has never registered", async () => {
    await expect(
      authorizeLifeManagerCapability(REQUEST, resolver({ envelope: undefined }), NOW),
    ).rejects.toBeInstanceOf(LifeManagerUnknownAuthorizationRefError);
  });

  it("keeps the opaque ref out of the refusal", async () => {
    const error = await authorizeLifeManagerCapability(
      REQUEST,
      resolver({ envelope: undefined }),
      NOW,
    ).catch((caught: unknown) => caught as Error);

    expect(error.message).not.toContain("5593059");
  });
});
