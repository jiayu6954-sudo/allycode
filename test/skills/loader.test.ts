import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let testDataDir: string | undefined;

afterEach(() => {
  delete process.env["ALLYCODE_DATA_DIR"];
  vi.resetModules();
  testDataDir = undefined;
});

async function loadIsolatedSkills() {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "allycode-skill-test-"));
  process.env["ALLYCODE_DATA_DIR"] = testDataDir;
  vi.resetModules();
  return import("../../src/skills/loader.js");
}

describe("desktop-manageable skills", () => {
  it("discovers the bundled Excel workflow without copying it into user settings, only on matching tasks",async()=>{
    const skills=await loadIsolatedSkills();
    const loaded=skills.loadSkills();
    expect(skills.listSkillDocuments()).toEqual([]);
    const excel=skills.matchSkills(loaded,"整理资料生成 Excel");
    expect(excel.find(item=>item.id==="builtin-sources-to-excel")?.body).toContain("document_ocr");
    expect(skills.formatSkillsForPrompt(excel)).toContain("coverage");
    expect(excel.find(item=>item.id==="builtin-excel-formulas")?.body).toContain("XLOOKUP");
    expect(skills.matchSkills(loaded,"用 SUMIFS 公式按店铺汇总").some(item=>item.id==="builtin-excel-formulas")).toBe(true);
    expect(skills.matchSkills(loaded,"修复登录按钮")).toEqual([]);
  });
  it("creates defaults and keeps disabled skills out of prompt loading", async () => {
    const skills = await loadIsolatedSkills();
    skills.initDefaultSkills();
    expect(skills.listSkillDocuments()).toHaveLength(3);

    const debug = skills.listSkillDocuments().find((item) => item.id === "debug-workflow")!;
    skills.saveSkillDocument({ ...debug, enabled: false });

    expect(skills.listSkillDocuments().find((item) => item.id === debug.id)?.enabled).toBe(false);
    expect(skills.loadSkills().some((item) => item.id === debug.id)).toBe(false);
  });

  it("round-trips a user workflow and rejects traversal identifiers", async () => {
    const skills = await loadIsolatedSkills();
    const document = {
      id: "safe-review",
      name: "安全审查",
      triggers: ["审查", "review"],
      body: "先读取代码，再给出有证据的结论。",
      enabled: true,
    };
    skills.saveSkillDocument(document);
    expect(skills.listSkillDocuments()).toEqual([document]);
    expect(() => skills.saveSkillDocument({ ...document, id: "../escape" })).toThrow(/标识/);

    skills.deleteSkillDocument(document.id);
    expect(skills.listSkillDocuments()).toEqual([]);
  });
});
