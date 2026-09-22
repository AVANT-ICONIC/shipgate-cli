import type { ArtifactRef, StepResult } from "../config/schema.js";

export type PolicyStatus = "passed" | "blocked" | "invalid";

export type PolicyFinding = {
  id: string;
  rule?: string;
  severity?: string;
  message?: string;
  [key: string]: unknown;
};

export type PolicyResult = {
  exitCode: 0 | 1 | 2;
  status?: PolicyStatus;
  findings: PolicyFinding[];
  artifacts?: ArtifactRef[];
  stdout?: string;
  stderr?: string;
  error?: string;
  details?: Record<string, unknown>;
};

export type PolicyContext<TConfig = unknown> = {
  projectRoot: string;
  verificationRoot: string;
  config: TConfig;
};

export type PolicyModule<TConfig = unknown> = {
  id: string;
  run(context: PolicyContext<TConfig>): Promise<PolicyResult> | PolicyResult;
};

export type PolicyRegistration = {
  module: PolicyModule;
  enabled: boolean;
  config: unknown;
};

export type PolicyStepResult = StepResult & {
  kind: "policy";
  exitCode: 0 | 1 | 2;
};
