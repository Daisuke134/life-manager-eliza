const BOUNDED_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const LIFE_MANAGER_PROVIDER_NOT_ACTIVE =
  "LIFE_MANAGER_PROVIDER_NOT_ACTIVE" as const;

export interface ProviderEffectAdmissionRequest {
  readonly providerId: string;
  readonly capabilityId: string;
  readonly activeProviderIds: readonly string[];
}

export interface ProviderEffectAdmission {
  readonly providerId: string;
  readonly capabilityId: string;
  readonly admitted: true;
}

export class ProviderNotActiveError extends Error {
  readonly code = LIFE_MANAGER_PROVIDER_NOT_ACTIVE;
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider is not an active effect owner: ${providerId}`);
    this.name = "ProviderNotActiveError";
    this.providerId = providerId;
  }
}

function providerId(value: unknown, field: string): string {
  if (typeof value !== "string" || !BOUNDED_ID.test(value)) {
    throw new Error(`${field} must be a bounded provider id`);
  }
  return value;
}

export function admitProviderEffect(
  request: ProviderEffectAdmissionRequest,
): ProviderEffectAdmission {
  const requested = providerId(request.providerId, "providerId");
  if (
    !Array.isArray(request.activeProviderIds) ||
    !request.activeProviderIds.map((value) => providerId(value, "activeProviderIds")).includes(requested)
  ) {
    throw new ProviderNotActiveError(requested);
  }
  if (request.capabilityId !== "marketplace.application") {
    throw new Error("capabilityId is not admitted for marketplace effects");
  }
  return Object.freeze({
    providerId: requested,
    capabilityId: request.capabilityId,
    admitted: true as const,
  });
}
