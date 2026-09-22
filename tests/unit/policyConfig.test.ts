import { describe, expect, it } from "vitest";
import { shipGateConfigSchema } from "../../src/config/schema.js";
import { shipGateJsonSchema } from "../../src/config/jsonSchema.js";

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


  it.each([
    [".shipgate/policies/cleanroom.json", true],
    ["ci/cleanroom.json", true],
    ["config/ab/cleanroom.json", true],
    ["a..b/x.json", true],
    ["../x.json", false],
    ["a/../x.json", false],
    ["/abs.json", false],
    ["C:/x.json", false],
    ["C:\\x.json", false]
  ] as const)("keeps JSON Schema and Zod path validation aligned for %s", (configFile, accepted) => {
    const pattern = shipGateJsonSchema.$defs.cleanroomPolicy.properties.configFile.pattern;
    const jsonAccepts = new RegExp(pattern).test(configFile);
    const zodAccepts = shipGateConfigSchema.safeParse({ policies: { cleanroom: { configFile } } }).success;
    expect(jsonAccepts).toBe(accepted);
    expect(zodAccepts).toBe(accepted);
  });

  it("rejects misspelled Cleanroom config keys instead of silently defaulting", () => {
    expect(() => shipGateConfigSchema.parse({ policies: { cleanroom: { compareAgaints: "main" } } })).toThrow();
  });

  it("rejects unknown policy IDs", () => {
    expect(() => shipGateConfigSchema.parse({ policies: { unknown: { enabled: true } } })).toThrow();
  });
});
