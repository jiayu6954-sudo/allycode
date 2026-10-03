import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeWorkspaceRoot, isUnsafeWorkspaceRoot } from "../../src/tools/path-guard.js";

describe("workspace root guard", () => {
  it("rejects the current filesystem root", () => {
    const root = path.parse(path.resolve(process.cwd())).root;
    expect(isUnsafeWorkspaceRoot(root)).toBe(true);
    expect(() => assertSafeWorkspaceRoot(root)).toThrow("请选择或新建一个具体的项目文件夹");
  });

  it("allows a concrete project directory", () => {
    expect(isUnsafeWorkspaceRoot(path.join(path.parse(process.cwd()).root, "projects", "allycode"))).toBe(false);
  });
});

