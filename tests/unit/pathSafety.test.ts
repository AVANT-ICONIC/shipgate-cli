import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsidePath, resolveLocalPath } from "../../src/utils/pathSafety.js";

describe("path safety", () => {
  it("resolves relative paths inside the allowed root", () => {
    const root = path.resolve("/tmp/project");

    expect(resolveLocalPath(root, "dist/index.js", "file")).toBe(path.join(root, "dist", "index.js"));
    expect(isInsidePath(root, path.join(root, "dist"))).toBe(true);
  });

  it("rejects absolute paths, null bytes, and parent escapes", () => {
    const root = path.resolve("/tmp/project");

    expect(() => resolveLocalPath(root, "/tmp/project/file.txt", "file")).toThrow("must be a relative path");
    expect(() => resolveLocalPath(root, "C:\\tmp\\file.txt", "file")).toThrow("must be a relative path");
    expect(() => resolveLocalPath(root, "dist\0file.txt", "file")).toThrow("must not contain null bytes");
    expect(() => resolveLocalPath(root, "../outside.txt", "file")).toThrow("must resolve inside");
  });

  it("can allow command cwd movement inside a workspace root", () => {
    const workspace = path.resolve("/tmp/workspace");
    const project = path.join(workspace, "packages", "app");

    expect(resolveLocalPath(project, "../..", "cwd", workspace)).toBe(workspace);
    expect(() => resolveLocalPath(project, "../../..", "cwd", workspace)).toThrow("must resolve inside");
  });
});
