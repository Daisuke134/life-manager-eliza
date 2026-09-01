import {
  authorizeCapabilityDispatch,
  bindCapabilityRequest,
  CapabilityAuthorizationCoordinator,
  normalizeCapabilityActionReceipt,
  normalizeCapabilityRequest,
  PROVIDER_INTEGRATION_CONTRACT_VERSION,
  type AuthorizedCapabilityRequest,
  type BoundCapabilityRequest,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  authorizeLifeManagerCapability,
  LifeManagerHumanCeremonyRequiredError,
  lifeManagerCapabilityManifest,
  type LifeManagerAuthorizationRef,
} from "./capability-authorization.ts";

const VERSION = PROVIDER_INTEGRATION_CONTRACT_VERSION;
const CAPABILITY_ID = "marketplace.application";
const AUTHORIZATION_REF =
  "life-manager-authorization://opaque-application-1" as LifeManagerAuthorizationRef;
const INPUT_DIGEST = "a".repeat(64);
const BOUND_AT = "2026-08-30T12:00:00.000Z";
const ISSUED_AT = "2026-08-30T12:00:10.000Z";
const AUTHORIZED_NOW = Date.parse("2026-08-30T12:00:30.000Z");
const RECEIPT_NOW = Date.parse("2026-08-30T12:01:00.000Z");
const EXPIRES_AT = "2026-08-30T12:05:00.000Z";

function boundRequest(): BoundCapabilityRequest {
  return bindCapabilityRequest(
    normalizeCapabilityRequest({
      contractVersion: VERSION,
      requestId: "request-marketplace-application-1",
      capabilityId: CAPABILITY_ID,
      operation: "marketplace.application.submit",
      riskLevel: "R2",
      accountId: null,
      inputDigest: INPUT_DIGEST,
    }),
    {
      contractVersion: VERSION,
      accountId: "opaque-account-1",
      providerId: "opaque-provider-1",
      mode: "cloud",
      status: "connected",
      displayName: "Private account",
      capabilities: [{ capabilityId: CAPABILITY_ID, riskLevel: "R2", status: "available" }],
      lastUsedAt: null,
    },
    BOUND_AT,
  );
}

function allowedPolicy(request: BoundCapabilityRequest) {
  return {
    contractVersion: VERSION,
    decisionId: "policy-marketplace-application-1",
    requestDigest: request.requestDigest,
    riskLevel: request.riskLevel,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    outcome: "allowed" as const,
    confirmation: "not_required" as const,
  };
}

function confirmationPolicy(request: BoundCapabilityRequest) {
  return {
    contractVersion: VERSION,
    decisionId: "policy-marketplace-application-human-1",
    requestDigest: request.requestDigest,
    riskLevel: request.riskLevel,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    outcome: "confirmation_required" as const,
    confirmationId: "human-ceremony-1",
  };
}

function applicationReceipt(authorization: AuthorizedCapabilityRequest) {
  return {
    contractVersion: VERSION,
    authorizationId: authorization.authorizationId,
    policyDecisionId: authorization.policyDecisionId,
    policyDecisionDigest: authorization.policyDecisionDigest,
    confirmationId: authorization.confirmationId,
    confirmationGrantDigest: authorization.confirmationGrantDigest,
    requestDigest: authorization.requestDigest,
    accountId: authorization.account.accountId,
    capabilityId: authorization.capabilityId,
    operation: authorization.operation,
    inputDigest: authorization.inputDigest,
    effect: {
      receiptId: "application-receipt-1",
      operation: authorization.operation,
      resource: { kind: "marketplace.application", id: "opaque-application-1" },
      artifacts: [],
      idempotency: { key: authorization.requestDigest, replayed: false },
      observedAt: "2026-08-30T12:00:40.000Z",
      outcome: "applied",
      commit: {
        kind: "provider_accepted",
        id: "opaque-commit-1",
        committedAt: "2026-08-30T12:00:39.000Z",
      },
    },
  };
}

describe("Life Manager capability authorization contract", () => {
  it("publishes one provider-neutral capability with safe unknown defaults", () => {
    expect(lifeManagerCapabilityManifest).toEqual({
      version: 1,
      defaultState: "unknown",
      capabilities: [
        {
          id: CAPABILITY_ID,
          authorization: { required: true },
          humanOnlyKinds: ["identity", "financial", "physical_capture", "client_reserved"],
          readback: { recordType: "application_receipt" },
        },
      ],
    });
    expect(Object.isFrozen(lifeManagerCapabilityManifest)).toBe(true);
    expect(Object.isFrozen(lifeManagerCapabilityManifest.capabilities)).toBe(true);
    expect(Object.isFrozen(lifeManagerCapabilityManifest.capabilities[0])).toBe(true);

    const wire = JSON.stringify(lifeManagerCapabilityManifest);
    expect(wire).not.toMatch(/provider|account|credential|secret|skill/i);
    expect(wire).not.toMatch(/lancers|fiverr|coconala|mercari/i);
  });

  it("delegates opaque authorization to real Eliza consume-once core and stops at human ceremony", async () => {
    const request = boundRequest();
    const coordinator = new CapabilityAuthorizationCoordinator({
      isSnapshotCurrent: () => true,
    });
    const policy = coordinator.register(
      allowedPolicy(request),
      request,
      AUTHORIZED_NOW,
    );
    const resolverCalls: unknown[] = [];
    const resolve = async (publicRequest: unknown) => {
      resolverCalls.push(publicRequest);
      return { request, policy, coordinator };
    };

    const authority = await authorizeLifeManagerCapability(
      { capabilityId: CAPABILITY_ID, authorizationRef: AUTHORIZATION_REF },
      { resolve },
      AUTHORIZED_NOW,
    );
    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]).toEqual({
      capabilityId: CAPABILITY_ID,
      authorizationRef: AUTHORIZATION_REF,
    });
    expect(Object.keys(resolverCalls[0] as Record<string, unknown>)).toEqual([
      "capabilityId",
      "authorizationRef",
    ]);
    expect(authority).toMatchObject({
      capabilityId: CAPABILITY_ID,
      requestDigest: request.requestDigest,
      policyDecisionId: policy.decisionId,
      confirmationId: null,
    });
    expect(Object.isFrozen(authority)).toBe(true);

    const coreReceipt = applicationReceipt(authority);
    expect(
      JSON.stringify(
        normalizeCapabilityActionReceipt(coreReceipt, {
          authorization: authority,
          now: RECEIPT_NOW,
        }),
      ),
    ).toContain(CAPABILITY_ID);
    await expect(
      authorizeLifeManagerCapability(
        { capabilityId: CAPABILITY_ID, authorizationRef: AUTHORIZATION_REF },
        { resolve },
        AUTHORIZED_NOW,
      ),
    ).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });

    const humanRequest = boundRequest();
    const humanCoordinator = new CapabilityAuthorizationCoordinator({
      isSnapshotCurrent: () => true,
    });
    const humanPolicy = humanCoordinator.register(
      confirmationPolicy(humanRequest),
      humanRequest,
      AUTHORIZED_NOW,
    );
    let humanResolverExecuted = false;
    const humanResolve = async (publicRequest: unknown) => {
      humanResolverExecuted = true;
      expect(publicRequest).toEqual({
        capabilityId: CAPABILITY_ID,
        authorizationRef: AUTHORIZATION_REF,
      });
      return {
        request: humanRequest,
        policy: humanPolicy,
        coordinator: humanCoordinator,
      };
    };

    await expect(
      authorizeLifeManagerCapability(
        { capabilityId: CAPABILITY_ID, authorizationRef: AUTHORIZATION_REF },
        { resolve: humanResolve },
        AUTHORIZED_NOW,
      ),
    ).rejects.toMatchObject({
      code: "LIFE_MANAGER_HUMAN_CEREMONY_REQUIRED",
    });
    expect(humanResolverExecuted).toBe(true);
    await expect(
      authorizeCapabilityDispatch(humanRequest, humanPolicy, {
        authorizationConsumer: humanCoordinator,
        now: AUTHORIZED_NOW,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_CONFIRMATION_REQUIRED" });
    expect(JSON.stringify({ capabilityId: CAPABILITY_ID, authorizationRef: AUTHORIZATION_REF })).not.toMatch(
      /provider|account|credential|secret|skill/i,
    );
  });

  it("does not reinterpret an allowed-policy consumer failure as human ceremony", async () => {
    const request = boundRequest();
    const policy = allowedPolicy(request);
    const coreFailure = Object.assign(
      new Error("core confirmation boundary"),
      { code: "CAPABILITY_CONFIRMATION_REQUIRED" },
    );
    const resolve = async () => ({
      request,
      policy,
      coordinator: {
        async consume() {
          throw coreFailure;
        },
      },
    });

    let error: unknown;
    try {
      await authorizeLifeManagerCapability(
        { capabilityId: CAPABILITY_ID, authorizationRef: AUTHORIZATION_REF },
        { resolve },
        AUTHORIZED_NOW,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(coreFailure);
    expect(error).toMatchObject({ code: "CAPABILITY_CONFIRMATION_REQUIRED" });
    expect(error).not.toBeInstanceOf(LifeManagerHumanCeremonyRequiredError);
  });
});
