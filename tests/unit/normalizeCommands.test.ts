import { describe, expect, it } from "vitest";
import { normalizeVerificationCommands } from "../../src/config/normalizeCommands.js";

describe("normalizeVerificationCommands", () => {
  it("requires every configured string command by default", () => {
    const steps = normalizeVerificationCommands({
      lint: "pnpm lint",
      test: "pnpm test",
      custom: []
    });

    expect(steps.map((step) => step.required)).toEqual([true, true]);
  });

  it("preserves explicitly optional command steps", () => {
    const steps = normalizeVerificationCommands({
      test: {
        name: "test",
        command: "pnpm test",
        required: false
      },
      custom: []
    });

    expect(steps[0]?.required).toBe(false);
  });
});
