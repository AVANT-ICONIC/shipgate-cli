export { defineShipGateConfig } from "./config/defineShipGateConfig.js";
export { shipGateJsonSchema } from "./config/jsonSchema.js";
export type {
  ArtifactRef,
  BrowserFlow,
  CommandHookPhase,
  CommandHooksConfig,
  CliFlow,
  CleanroomPolicyConfig,
  CommandConfig,
  FlowConfig,
  PoliciesConfig,
  ShipGateConfig,
  ShipGateConfigInput,
  StepResult,
  VerificationResult,
  WorkspaceConfig
} from "./config/schema.js";

export { PolicyRegistry, builtInPolicies } from "./policies/registry.js";
export { disabledPolicyStep, policyResultToStepResult, runPolicy } from "./policies/runner.js";
export type { PolicyContext, PolicyFinding, PolicyModule, PolicyResult, PolicyStatus, PolicyStepResult } from "./policies/types.js";
