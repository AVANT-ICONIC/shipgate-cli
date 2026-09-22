import { describe, expect, it } from "vitest";
import { PolicyRegistry } from "../../src/policies/registry.js";
import type { PolicyModule } from "../../src/policies/types.js";

function module(id: string): PolicyModule {
  return { id, run: () => ({ exitCode: 0, findings: [] }) };
}

describe("PolicyRegistry", () => {
  it("registers and retrieves policy modules without running them", () => {
    let runs = 0;
    const policy: PolicyModule = { id: "example", run: () => { runs += 1; return { exitCode: 0, findings: [] }; } };
    const registry = new PolicyRegistry([policy]);
    expect(registry.get("example")).toBe(policy);
    expect(registry.ids()).toEqual(["example"]);
    expect(runs).toBe(0);
  });

  it("rejects duplicate, blank, and unknown policy IDs", () => {
    const registry = new PolicyRegistry([module("known")]);
    expect(() => registry.register(module("known"))).toThrow("already registered");
    expect(() => registry.register(module("  "))).toThrow("must not be empty");
    expect(() => registry.get("missing")).toThrow("Unknown policy: missing");
  });
});
