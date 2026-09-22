import type { PolicyContext, PolicyModule, PolicyResult, PolicyStatus, PolicyStepResult } from "./types.js";

const STATUS_BY_EXIT_CODE = { 0: "passed", 1: "blocked", 2: "invalid" } as const;
type RuntimePolicyResult = Partial<PolicyResult> & Record<string, unknown>;

function statusFor(exitCode: PolicyResult["exitCode"]): PolicyStepResult["status"] {
  return exitCode === 0 ? "passed" : "failed";
}

function invalidResult(message: string, rawResult?: unknown): PolicyResult {
  return {
    exitCode: 2,
    status: "invalid",
    findings: [],
    error: message,
    details: { rawResult }
  };
}

function validateResult(value: unknown): PolicyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidResult("Policy returned a non-object result.", value);
  }

  const raw = value as RuntimePolicyResult;
  if (raw.exitCode !== 0 && raw.exitCode !== 1 && raw.exitCode !== 2) {
    return invalidResult(`Policy returned invalid exitCode: ${String(raw.exitCode)}. Expected 0, 1, or 2.`, value);
  }
  if (!Array.isArray(raw.findings)) {
    return invalidResult("Policy returned invalid findings: expected an array.", value);
  }

  const expectedStatus: PolicyStatus = STATUS_BY_EXIT_CODE[raw.exitCode];
  if (raw.status !== undefined && raw.status !== expectedStatus) {
    return invalidResult(
      `Policy returned status ${String(raw.status)} for exitCode ${raw.exitCode}; expected ${expectedStatus}.`,
      value
    );
  }
  const details = raw.details;
  const plainDetails = details !== null
    && typeof details === "object"
    && !Array.isArray(details)
    && (Object.getPrototypeOf(details) === Object.prototype || Object.getPrototypeOf(details) === null);
  return {
    ...raw,
    exitCode: raw.exitCode,
    status: expectedStatus,
    findings: raw.findings,
    details: plainDetails ? details as Record<string, unknown> : { rawDetails: details }
  } as PolicyResult;
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
      policyStatus: STATUS_BY_EXIT_CODE[result.exitCode],
      findings: result.findings
    }
  };
}

export async function runPolicy<TConfig>(
  module: PolicyModule<TConfig>,
  context: PolicyContext<TConfig>
): Promise<PolicyStepResult> {
  const startedAt = new Date().toISOString();
  let result: PolicyResult;
  try {
    result = validateResult(await module.run(context));
  } catch (error) {
    result = invalidResult(
      `Policy ${module.id} threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
