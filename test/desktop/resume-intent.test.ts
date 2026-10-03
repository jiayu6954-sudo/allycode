import { describe, expect, it } from "vitest";
import { isResumeIntent } from "../../desktop/renderer/src/resume-intent.js";

describe("desktop resume intent", () => {
  it.each(["继续", "请继续", "请接续", "接着执行。", "继续执行！"])(
    "recognizes %s as an exact resume action",
    (value) => expect(isResumeIntent(value)).toBe(true),
  );

  it.each(["继续开发新模块", "请继续，但换一个目录", "重新开始", ""])(
    "does not hijack a substantive new prompt: %s",
    (value) => expect(isResumeIntent(value)).toBe(false),
  );
});
