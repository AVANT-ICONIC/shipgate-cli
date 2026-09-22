import { describe, expect, it } from "vitest";
import { shipGateConfigSchema } from "../../src/config/schema.js";

describe("policy configuration", () => {
  it("defaults Cleanroom disabled with a safe project-relative config path", () => {
    const config = shipGateConfigSchema.parse({});
    expect(config.policies.cleanroom).toEqual({
      enabled: false,
      configFile: ".shipgate/policies/cleanroom.json",
      compareAgainst: "auto"
    });
  });

  it.each(["../cleanroom.json", "/tmp/cleanroom.json", "C:\\tmp\\cleanroom.json"])(
    "rejects unsafe config path %s", (configFile) => {
      expect(() => shipGateConfigSchema.parse({ policies: { cleanroom: { configFile } } })).toThrow("inside the project root");
    }
  );

  it("rejects misspelled Cleanroom config keys instead of silently defaulting", () => {
    expect(() => shipGateConfigSchema.parse({ policies: { cleanroom: { compareAgaints: "main" } } })).toThrow();
  });

  it("rejects unknown policy IDs", () => {
    expect(() => shipGateConfigSchema.parse({ policies: { unknown: { enabled: true } } })).toThrow();
  });
});
