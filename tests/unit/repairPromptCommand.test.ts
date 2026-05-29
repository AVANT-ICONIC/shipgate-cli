import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairPromptCommand } from "../../src/commands/repairPrompt.js";

const tempRoots: string[] = [];

async function createRootWithPrompt(content = "repair this\n"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shipgate-repair-command-test-"));
  tempRoots.push(root);
  await mkdir(path.join(root, ".shipgate"), { recursive: true });
  await writeFile(path.join(root, ".shipgate", "latest-repair-prompt.md"), content, "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repair-prompt command", () => {
  it("prints the latest repair prompt by default", async () => {
    const root = await createRootWithPrompt("fix the test\n");
    let stdout = "";
    let stderr = "";

    const code = await runRepairPromptCommand({}, {
      projectRoot: root,
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      }
    });

    expect(code).toBe(0);
    expect(stdout).toBe("fix the test\n");
    expect(stderr).toBe("");
  });

  it("copies the latest repair prompt when requested", async () => {
    const root = await createRootWithPrompt("copy this prompt\n");
    let copied = "";
    let stdout = "";
    let stderr = "";

    const code = await runRepairPromptCommand({ copy: true }, {
      projectRoot: root,
      copyText: async (text) => {
        copied = text;
      },
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      }
    });

    expect(code).toBe(0);
    expect(copied).toBe("copy this prompt\n");
    expect(stdout).toBe("");
    expect(stderr).toBe("Copied ShipGate repair prompt to clipboard.\n");
  });

  it("fails when no repair prompt exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shipgate-repair-command-test-"));
    tempRoots.push(root);
    let stderr = "";

    const code = await runRepairPromptCommand({}, {
      projectRoot: root,
      writeErr: (text) => {
        stderr += text;
      }
    });

    expect(code).toBe(2);
    expect(stderr).toContain("No ShipGate repair prompt found");
  });
});
