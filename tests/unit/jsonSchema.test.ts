import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSchemaCommand, schemaJson } from "../../src/commands/schema.js";
import { shipGateJsonSchema } from "../../src/config/jsonSchema.js";

describe("shipGateJsonSchema", () => {
  it("exports the current config surface as JSON Schema", () => {
    const properties = Object.keys(shipGateJsonSchema.properties);

    expect(shipGateJsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(shipGateJsonSchema.title).toBe("ShipGate Configuration");
    expect(properties).toEqual([
      "profile",
      "packageManager",
      "workspace",
      "commands",
      "hooks",
      "app",
      "flows",
      "requiredFiles",
      "artifacts",
      "fresh",
      "failurePolicy",
      "discovery",
      "policies",
      "env"
    ]);
    expect(shipGateJsonSchema.$defs.commandStep.required).toEqual(["name", "command"]);
    expect(shipGateJsonSchema.$defs.flow.oneOf).toHaveLength(4);
    expect(shipGateJsonSchema.$defs.discovery.properties.maxRoutes.default).toBe(10);
    expect(shipGateJsonSchema.$defs.discovery.properties.formMode.default).toBe("inspect");
    expect(shipGateJsonSchema.$defs.discovery.properties.accessibilityScan.default).toBe(false);
    expect(shipGateJsonSchema.$defs.discovery.properties.screenshotBaselineMode.default).toBe("off");
    expect(shipGateJsonSchema.$defs.discovery.properties.screenshotBaselineDir.default).toBe(".shipgate/discovery-screenshots");
    expect(shipGateJsonSchema.$defs.discovery.properties.denyTextPatterns.default).toContain("destroy");
    expect(shipGateJsonSchema.$defs.policies.additionalProperties).toBe(false);
    expect(shipGateJsonSchema.$defs.cleanroomPolicy.properties.enabled.default).toBe(false);
    expect(shipGateJsonSchema.$defs.cleanroomPolicy.properties.configFile.default)
      .toBe(".shipgate/policies/cleanroom.json");
  });

  it("writes schema JSON through the CLI command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-schema-test-"));
    const outPath = path.join(root, "shipgate.schema.json");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
    registerSchemaCommand(program);

    await program.parseAsync(["node", "shipgate", "schema", "--out", outPath], { from: "node" });
    const written = await readFile(outPath, "utf8");

    expect(JSON.parse(written)).toEqual(JSON.parse(schemaJson()));

    await rm(root, { recursive: true, force: true });
  });
});
