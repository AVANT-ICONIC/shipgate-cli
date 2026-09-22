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

  it("fails closed when a module claims exit 0 with blocked status", async () => {
    const module = { id: "contradictory", run: () => ({ exitCode: 0, status: "blocked", findings: [] }) } as unknown as PolicyModule<typeof context.config>;
    const step = await runPolicy(module, context);
    expect(step).toMatchObject({
      status: "failed", exitCode: 2,
      error: "Policy returned status blocked for exitCode 0; expected passed.",
      details: { policyStatus: "invalid", rawResult: { exitCode: 0, status: "blocked", findings: [] } }
    });
  });

  it("turns a thrown analyzer error into an invalid evidence-bearing step", async () => {
    const module: PolicyModule<typeof context.config> = { id: "throwing", run: () => { throw new Error("analyzer crashed"); } };
    const step = await runPolicy(module, context);
    expect(step).toMatchObject({
      status: "failed", exitCode: 2,
      error: "Policy throwing threw: analyzer crashed",
      details: { policyStatus: "invalid", findings: [] }
    });
  });

  it("fails closed on an untyped result with invalid exitCode and findings", async () => {
    const raw = { exitCode: undefined, findings: undefined };
    const module = { id: "unchecked-js", run: () => raw } as unknown as PolicyModule<typeof context.config>;
    const step = await runPolicy(module, context);
    expect(step).toMatchObject({
      status: "failed", exitCode: 2,
      error: "Policy returned invalid exitCode: undefined. Expected 0, 1, or 2.",
      details: { policyStatus: "invalid", rawResult: raw }
    });
  });

  it("represents a disabled policy as an explicit skipped step", () => {
    expect(disabledPolicyStep("example")).toMatchObject({
      id: "policy:example", kind: "policy", status: "skipped", exitCode: 0,
      details: { policyStatus: "disabled", findings: [] }
    });
  });
});
