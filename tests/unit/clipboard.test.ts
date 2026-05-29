import { describe, expect, it } from "vitest";
import {
  clipboardCommands,
  copyToClipboard,
  type ClipboardCommand
} from "../../src/utils/clipboard.js";

describe("clipboard utilities", () => {
  it("uses native clipboard commands per platform", () => {
    expect(clipboardCommands("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
    expect(clipboardCommands("win32")).toEqual([{ command: "clip", args: [] }]);
    expect(clipboardCommands("linux")).toEqual([
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    ]);
  });

  it("tries Linux clipboard fallbacks until one succeeds", async () => {
    const attempts: ClipboardCommand[] = [];

    const result = await copyToClipboard("repair prompt", {
      platform: "linux",
      runner: async (command, text) => {
        attempts.push(command);
        expect(text).toBe("repair prompt");
        if (command.command === "wl-copy") throw new Error("missing wl-copy");
      }
    });

    expect(result).toEqual({ command: "xclip -selection clipboard" });
    expect(attempts.map((attempt) => attempt.command)).toEqual(["wl-copy", "xclip"]);
  });

  it("reports unsupported platforms", async () => {
    await expect(copyToClipboard("repair prompt", {
      platform: "aix",
      runner: async () => undefined
    })).rejects.toThrow("no clipboard commands configured for aix");
  });
});
