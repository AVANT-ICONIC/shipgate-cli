import type { PolicyContext, PolicyModule, PolicyResult, PolicyStepResult } from "./types.js";

function statusFor(exitCode: PolicyResult["exitCode"]): PolicyStepResult["status"] {
  return exitCode === 0 ? "passed" : "failed";
}

export function policyResultToStepResult(
  policyId: string,
  result: PolicyResult,
  startedAt: string,
  endedAt: string
): PolicyStepResult {
  return {
    id: `policy:${policyId}`,
    name: `${policyId} policy`,
    kind: "policy",
    status: statusFor(result.exitCode),
    required: true,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    exitCode: result.exitCode,
    stdoutExcerpt: result.stdout,
    stderrExcerpt: result.stderr,
    error: result.error,
    artifacts: result.artifacts,
    details: {
      ...result.details,
      policyStatus: result.status ?? (result.exitCode === 0 ? "passed" : result.exitCode === 1 ? "blocked" : "invalid"),
      findings: result.findings
    }
  };
}

export async function runPolicy<TConfig>(
  module: PolicyModule<TConfig>,
  context: PolicyContext<TConfig>
): Promise<PolicyStepResult> {
  const startedAt = new Date().toISOString();
  const result = await module.run(context);
  const endedAt = new Date().toISOString();
  return policyResultToStepResult(module.id, result, startedAt, endedAt);
}

export function disabledPolicyStep(policyId: string): PolicyStepResult {
  const now = new Date().toISOString();
  return {
    id: `policy:${policyId}`,
    name: `${policyId} policy`,
    kind: "policy",
    status: "skipped",
    required: true,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    exitCode: 0,
    details: { policyStatus: "disabled", findings: [] }
  };
}
