/**
 * ELZ-L04: the host side of the ELZ-C06 authorization seam.
 *
 * The public request carries only a capability id and an opaque ref, so this
 * resolver is where the ref becomes a bound request, a policy decision, and a
 * consume-once coordinator. Both lookups are injected: the plugin never reads a
 * path of its own.
 *
 * It fails closed. The manifest's default state is "unknown", so anything this
 * resolver cannot positively allow comes back as confirmation_required, which
 * `authorizeLifeManagerCapability` turns into the human ceremony error.
 */
import {
  bindCapabilityRequest,
  CapabilityAuthorizationCoordinator,
  normalizeCapabilityRequest,
  PROVIDER_INTEGRATION_CONTRACT_VERSION,
  type BoundCapabilityRequest,
} from "@elizaos/core";
import type {
  LifeManagerAuthorizationRef,
  LifeManagerAuthorizationResolver,
  LifeManagerCapabilityRequest,
} from "./capability-authorization.ts";

type MaybePromise<T> = T | PromiseLike<T>;

/** What the opaque ref stands for. Kept private to the host. */
export interface LifeManagerAuthorizationEnvelope {
  readonly requestId: string;
  readonly operation: string;
  readonly riskLevel: string;
  readonly inputDigest: string;
  readonly accountId: string | null;
  readonly account: unknown;
  readonly boundAt: string;
}

/** Dais's standing decision for one capability, read from private state. */
export interface LifeManagerStandingPolicy {
  readonly capability_id: string;
  readonly outcome: string;
  readonly platform?: string;
}

export interface LifeManagerPolicyResolverDependencies {
  readonly loadEnvelope: (
    ref: LifeManagerAuthorizationRef,
  ) => MaybePromise<LifeManagerAuthorizationEnvelope | undefined>;
  readonly loadStandingPolicy: (
    capabilityId: string,
  ) => MaybePromise<LifeManagerStandingPolicy | undefined>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly isSnapshotCurrent?: (
    request: BoundCapabilityRequest,
    now: number,
  ) => boolean;
}

export const LIFE_MANAGER_AUTHORIZATION_UNKNOWN_REF =
  "LIFE_MANAGER_AUTHORIZATION_UNKNOWN_REF" as const;

export class LifeManagerUnknownAuthorizationRefError extends Error {
  readonly code = LIFE_MANAGER_AUTHORIZATION_UNKNOWN_REF;

  constructor() {
    // The ref itself stays out of the message: it is the lookup key.
    super("Life Manager authorization ref is not registered");
    this.name = "LifeManagerUnknownAuthorizationRefError";
  }
}

export const LIFE_MANAGER_AUTHORIZATION_ALREADY_SPENT =
  "LIFE_MANAGER_AUTHORIZATION_ALREADY_SPENT" as const;

export class LifeManagerAuthorizationAlreadySpentError extends Error {
  readonly code = LIFE_MANAGER_AUTHORIZATION_ALREADY_SPENT;

  constructor() {
    super("Life Manager authorization ref has already been spent");
    this.name = "LifeManagerAuthorizationAlreadySpentError";
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function isoAt(millis: number): string {
  return new Date(millis).toISOString();
}

export function createLifeManagerPolicyResolver(
  dependencies: LifeManagerPolicyResolverDependencies,
): LifeManagerAuthorizationResolver {
  if (
    !dependencies ||
    typeof dependencies.loadEnvelope !== "function" ||
    typeof dependencies.loadStandingPolicy !== "function"
  ) {
    throw new Error("Life Manager policy resolver is missing its lookups");
  }
  const clock = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
  const coordinator = new CapabilityAuthorizationCoordinator({
    isSnapshotCurrent:
      dependencies.isSnapshotCurrent ?? (() => true),
  });
  let sequence = 0;
  // One ref buys one dispatch. Minting a fresh decision per resolve would let
  // the same opaque ref be spent forever, which is the replay the consume-once
  // core exists to refuse.
  const spent = new Set<string>();

  return {
    async resolve(request: LifeManagerCapabilityRequest) {
      if (spent.has(request.authorizationRef)) {
        throw new LifeManagerAuthorizationAlreadySpentError();
      }
      const envelope = await dependencies.loadEnvelope(request.authorizationRef);
      if (!envelope) throw new LifeManagerUnknownAuthorizationRefError();
      spent.add(request.authorizationRef);

      const bound = bindCapabilityRequest(
        normalizeCapabilityRequest({
          contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
          requestId: envelope.requestId,
          capabilityId: request.capabilityId,
          operation: envelope.operation,
          riskLevel: envelope.riskLevel,
          accountId: envelope.accountId,
          inputDigest: envelope.inputDigest,
        }),
        envelope.account,
        envelope.boundAt,
      );

      const standing = await dependencies.loadStandingPolicy(
        request.capabilityId,
      );
      const allowed =
        standing?.outcome === "allowed" &&
        standing.capability_id === request.capabilityId;

      const now = clock();
      sequence += 1;
      const base = {
        contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
        decisionId: `life-manager-policy-${bound.requestDigest.slice(0, 16)}-${sequence}`,
        requestDigest: bound.requestDigest,
        riskLevel: bound.riskLevel,
        issuedAt: isoAt(now),
        expiresAt: isoAt(now + ttlMs),
      };
      const decision = allowed
        ? { ...base, outcome: "allowed" as const, confirmation: "not_required" as const }
        : {
            ...base,
            outcome: "confirmation_required" as const,
            confirmationId: `life-manager-ceremony-${base.decisionId}`,
          };

      const policy = coordinator.register(decision, bound, now);
      return { request: bound, policy, coordinator };
    },
  };
}
