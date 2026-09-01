import type {
  AuthorizedCapabilityRequest,
  BoundCapabilityRequest,
  CapabilityAuthorizationConsumer,
  CapabilityConfirmationGrant,
  CapabilityPolicyDecision,
} from "@elizaos/core";
import { authorizeCapabilityDispatch } from "@elizaos/core";

export type LifeManagerAuthorizationRef =
  `life-manager-authorization://${string}`;

export interface LifeManagerCapabilityRequest {
  capabilityId: string;
  authorizationRef: LifeManagerAuthorizationRef;
}

export const lifeManagerCapabilityManifest = Object.freeze({
  version: 1 as const,
  defaultState: "unknown" as const,
  capabilities: Object.freeze([
    Object.freeze({
      id: "marketplace.application" as const,
      authorization: Object.freeze({ required: true as const }),
      humanOnlyKinds: Object.freeze([
        "identity",
        "financial",
        "physical_capture",
        "client_reserved",
      ] as const),
      readback: Object.freeze({ recordType: "application_receipt" as const }),
    }),
  ]),
});

const AUTHORIZATION_SCHEME = "life-manager-authorization://";
const CONTROL = /[\u0000-\u001f\u007f]/u;

function invalidRequest(message: string): never {
  throw new Error(`Invalid Life Manager capability request: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("request must be an object");
  }
  return value as Record<string, unknown>;
}

export function normalizeLifeManagerCapabilityRequest(
  value: unknown,
): LifeManagerCapabilityRequest {
  const raw = record(value);
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "authorizationRef,capabilityId") {
    return invalidRequest("request must contain only capabilityId and authorizationRef");
  }
  const capabilityId = raw.capabilityId;
  if (
    typeof capabilityId !== "string" ||
    capabilityId.length === 0 ||
    capabilityId.length > 256 ||
    CONTROL.test(capabilityId) ||
    !lifeManagerCapabilityManifest.capabilities.some(({ id }) => id === capabilityId)
  ) {
    return invalidRequest("capabilityId is not declared by the manifest");
  }
  const authorizationRef = raw.authorizationRef;
  if (
    typeof authorizationRef !== "string" ||
    authorizationRef.length <= AUTHORIZATION_SCHEME.length ||
    authorizationRef.length > 512 ||
    CONTROL.test(authorizationRef) ||
    !authorizationRef.startsWith(AUTHORIZATION_SCHEME)
  ) {
    return invalidRequest("authorizationRef must be an opaque bounded reference");
  }
  return Object.freeze({
    capabilityId,
    authorizationRef: authorizationRef as LifeManagerAuthorizationRef,
  });
}

interface LifeManagerResolvedAuthorization {
  request: BoundCapabilityRequest;
  policy: CapabilityPolicyDecision;
  coordinator: CapabilityAuthorizationConsumer;
  confirmationGrant?: CapabilityConfirmationGrant;
}

export interface LifeManagerAuthorizationResolver {
  resolve(
    request: LifeManagerCapabilityRequest,
  ): Promise<LifeManagerResolvedAuthorization>;
}

export async function resolveLifeManagerAuthorization(
  value: unknown,
  dependencies: LifeManagerAuthorizationResolver,
): Promise<LifeManagerResolvedAuthorization> {
  const request = normalizeLifeManagerCapabilityRequest(value);
  if (!dependencies || typeof dependencies.resolve !== "function") {
    throw new Error("Life Manager authorization resolver is unavailable");
  }
  return dependencies.resolve(request);
}

export const LIFE_MANAGER_HUMAN_CEREMONY_REQUIRED = "LIFE_MANAGER_HUMAN_CEREMONY_REQUIRED" as const;

export class LifeManagerHumanCeremonyRequiredError extends Error {
  readonly code = LIFE_MANAGER_HUMAN_CEREMONY_REQUIRED;
  readonly capabilityId: string;
  readonly authorizationRef: LifeManagerAuthorizationRef;
  readonly humanOnlyKinds = lifeManagerCapabilityManifest.capabilities[0].humanOnlyKinds;

  constructor(request: LifeManagerCapabilityRequest) {
    super("Life Manager capability requires a human ceremony");
    this.name = "LifeManagerHumanCeremonyRequiredError";
    this.capabilityId = request.capabilityId;
    this.authorizationRef = request.authorizationRef;
  }
}

export async function authorizeLifeManagerCapability(
  value: unknown,
  dependencies: LifeManagerAuthorizationResolver,
  now?: number,
): Promise<AuthorizedCapabilityRequest> {
  const publicRequest = normalizeLifeManagerCapabilityRequest(value);
  const resolved = await resolveLifeManagerAuthorization(
    publicRequest,
    dependencies,
  );
  if (resolved.request.capabilityId !== publicRequest.capabilityId) {
    throw new Error("Life Manager authorization capability mismatch");
  }
  const options: Parameters<typeof authorizeCapabilityDispatch>[2] = {
    authorizationConsumer: resolved.coordinator,
  };
  if (resolved.confirmationGrant) {
    options.confirmationGrant = resolved.confirmationGrant;
  }
  if (now !== undefined) options.now = now;
  try {
    return await authorizeCapabilityDispatch(
      resolved.request,
      resolved.policy,
      options,
    );
  } catch (error) {
    if (
      resolved.policy.outcome === "confirmation_required" &&
      resolved.confirmationGrant === undefined &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "CAPABILITY_CONFIRMATION_REQUIRED"
    ) {
      throw new LifeManagerHumanCeremonyRequiredError(publicRequest);
    }
    throw error;
  }
}
