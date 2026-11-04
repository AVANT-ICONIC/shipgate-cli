// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ArtifactRef, CleanroomPolicyConfig } from "../../config/schema.js";
import type { PolicyFinding, PolicyModule, PolicyResult } from "../types.js";
import { evaluateCheck } from "../cleanroom/check.mjs";

/**
 * ShipGate policy-pack entry point for the ported Cleanroom policy (spec
 * Step 4). `runVerification()` calls `run()` against the verification root
 * (the fresh copy under `--fresh`) and receives a `PolicyResult`. The policy
 * never exits the process: blocking findings return exitCode 1, invalid
 * state (missing baseline, unreadable config, dual-state conflict) returns
 * exitCode 2, and every failure mode stays a value the runner can report.
 */

type CheckViolation = {
  id: string;
  rule: string;
  paths: string[];
  message: string;
  detail?: string;
};

type CheckSuccess = {
  exitCode: 0 | 1;
  compareRef: string | null;
  referenceLabel: string;
  fresh: CheckViolation[];
  resolved: CheckViolation[];
  waived: CheckViolation[];
  expiredWaivers: unknown[];
  current: { violations: CheckViolation[]; counts: Record<string, number>; entropy: number };
  text: string;
};

type CheckInvalid = { error: string; exitCode: 2 };

function isInvalid(result: CheckSuccess | CheckInvalid): result is CheckInvalid {
  return typeof (result as CheckInvalid).error === "string" && !Array.isArray((result as CheckSuccess).fresh);
}

function toFinding(violation: CheckViolation): PolicyFinding {
  return {
    id: violation.id,
    rule: violation.rule,
    severity: "blocking",
    message: violation.message,
    paths: violation.paths,
    detail: violation.detail
  };
}

export const cleanroomPolicy: PolicyModule<CleanroomPolicyConfig> = {
  id: "cleanroom",
  async run(context): Promise<PolicyResult> {
    let outcome: CheckSuccess | CheckInvalid;
    try {
      outcome = evaluateCheck(context.verificationRoot, {
        explicitCompareRef: context.config.compareAgainst === "auto" ? null : context.config.compareAgainst
      }) as CheckSuccess | CheckInvalid;
    } catch (error) {
      // StateConflictError and config/IO failures are invalid runs (exit 2),
      // never process exits (spec section 2.2 zero-exit rule).
      return {
        exitCode: 2,
        status: "invalid",
        findings: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }

    if (isInvalid(outcome)) {
      return { exitCode: 2, status: "invalid", findings: [], error: outcome.error };
    }

    const findings = outcome.fresh.map(toFinding);
    const details: Record<string, unknown> = {
      compareRef: outcome.compareRef,
      referenceLabel: outcome.referenceLabel,
      freshCount: outcome.fresh.length,
      resolvedCount: outcome.resolved.length,
      waivedCount: outcome.waived.length,
      violationCount: outcome.current.violations.length,
      counts: outcome.current.counts,
      entropy: outcome.current.entropy
    };

    const artifacts: ArtifactRef[] = [];
    if (context.artifacts) {
      artifacts.push(await context.artifacts.writeText(
        "json",
        "cleanroom policy result",
        "policies/cleanroom-result.json",
        `${JSON.stringify({ ...details, findings }, null, 2)}\n`
      ));
    }

    return {
      exitCode: outcome.exitCode,
      status: outcome.exitCode === 0 ? "passed" : "blocked",
      findings,
      artifacts,
      stdout: outcome.text,
      error: outcome.fresh.length
        ? `Cleanroom policy blocked: ${outcome.fresh.length} new violation${outcome.fresh.length === 1 ? "" : "s"} vs ${outcome.referenceLabel}.`
        : undefined,
      details
    };
  }
};
