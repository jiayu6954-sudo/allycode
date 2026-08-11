import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../../src/ui/components/StatusBar.js";
import type { AppState } from "../../src/types/ui.js";

const expectedLabels: Array<[AppState, string]> = [
  ["waiting_model", "等待模型首字节"],
  ["streaming", "模型正在输出"],
  ["tool_running", "正在执行工具"],
  ["waiting_model_after_tool", "工具已完成，等待模型继续"],
  ["completed", "任务已结束"],
];

describe("Ink StatusBar agent phases", () => {
  it.each(expectedLabels)("renders %s from the canonical phase", async (state, label) => {
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
    stdout.columns = 120;
    stdout.rows = 30;
    stdout.isTTY = true;
    let output = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    const view = render(React.createElement(StatusBar, {
      info: { model: "test-model", totalTokens: 0, estimatedCostUsd: 0 },
      state,
      showCost: false,
      showTokens: false,
      currentActivity: state === "tool_running" ? "grep src" : "",
      streamingTokens: state === "streaming" ? 12 : 0,
      termCols: 120,
    }), {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.unmount();
    expect(stripAnsi(output)).toContain(label);
  });
});
