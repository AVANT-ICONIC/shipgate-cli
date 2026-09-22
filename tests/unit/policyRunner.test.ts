import { describe, expect, it } from "vitest";
import { disabledPolicyStep, runPolicy } from "../../src/policies/runner.js";
import type { PolicyModule } from "../../src/policies/types.js";

const context = { projectRoot: "/project", verificationRoot: "/verify", config: { enabled: true } };

function policy(exitCode: 0 | 1 | 2): PolicyModule<typeof context.config> {
  return {
    id: "example",
    run: () => ({
      exitCode,
      findings: [{ id: "finding-1", rule: "example/rule" }],
      artifacts: [{ kind: "json", label: "policy evidence", path: ".shipgate/example.json" }],
      details: { retained: true }
    })
  };
}

describe("policy runner", () => {
  it.each([[0, "passed", "passed"], [1, "failed", "blocked"], [2, "failed", "invalid"]] as const)(
    "maps exit code %s exactly without losing findings or artifacts",
    async (exitCode, status, policyStatus) => {
      const step = await runPolicy(policy(exitCode), context);
      expect(step.kind).toBe("policy");
      expect(step.status).toBe(status);
      expect(step.exitCode).toBe(exitCode);
      expect(step.artifacts).toEqual([{ kind: "json", label: "policy evidence", path: ".shipgate/example.json" }]);
      expect(step.details).toMatchObject({
        retained: true,
        policyStatus,
        findings: [{ id: "finding-1", rule: "example/rule" }]
      });
    }
  );

  it("represents a disabled policy as an explicit skipped step", () => {
    expect(disabledPolicyStep("example")).toMatchObject({
      id: "policy:example", kind: "policy", status: "skipped", exitCode: 0,
      details: { policyStatus: "disabled", findings: [] }
    });
  });
});
