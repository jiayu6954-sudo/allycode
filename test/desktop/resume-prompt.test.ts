import { describe, expect, it } from "vitest";
import { buildResumePrompt } from "../../desktop/resume-prompt.js";

describe("desktop resume prompt", () => {
  it("carries a failed completion-gate reason into the resumed model context", () => {
    const prompt = buildResumePrompt({
      status: "failed",
      lastError: "独立完成门禁未通过：真实浏览器端到端验收。",
      checkpoint: {
        reason: "failed",
        conversationHistory: [],
        note: "独立完成门禁未通过：真实浏览器端到端验收。",
      },
    });

    expect(prompt).toContain("真实浏览器端到端验收");
    expect(prompt).toContain("重新运行对应的真实验收");
    expect(prompt).toContain("不要宣称任务完成");
  });

  it("keeps a paused resume concise when no failure reason exists", () => {
    const prompt = buildResumePrompt({ status: "paused" });
    expect(prompt).toContain("从已保存的检查点继续");
    expect(prompt).not.toContain("上次停止原因");
  });
});
