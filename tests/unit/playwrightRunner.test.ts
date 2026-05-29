import { describe, expect, it } from "vitest";
import { shouldTrackNetworkFailure } from "../../src/browser/playwrightRunner.js";

describe("shouldTrackNetworkFailure", () => {
  const appUrl = "https://app.example.test/dashboard";

  it("tracks requests from the app origin regardless of path", () => {
    expect(shouldTrackNetworkFailure(
      "https://app.example.test/api/invoices",
      appUrl,
      []
    )).toBe(true);
  });

  it("does not track third-party or origin-prefix lookalike requests", () => {
    expect(shouldTrackNetworkFailure(
      "https://cdn.example.test/app.js",
      appUrl,
      []
    )).toBe(false);
    expect(shouldTrackNetworkFailure(
      "https://app.example.test.attacker.invalid/api",
      appUrl,
      []
    )).toBe(false);
  });

  it("does not track allowed same-origin failures", () => {
    expect(shouldTrackNetworkFailure(
      "https://app.example.test/favicon.ico",
      appUrl,
      ["*/favicon.ico"]
    )).toBe(false);
  });
});
