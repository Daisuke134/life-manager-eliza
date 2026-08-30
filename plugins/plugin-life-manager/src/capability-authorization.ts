export type LifeManagerAuthorizationRef =
  `life-manager-authorization://${string}`;

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
