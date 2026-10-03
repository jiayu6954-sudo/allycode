import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop window startup", () => {
  it("arms ready-to-show before loading and has a deterministic visibility fallback", () => {
    const source = readFileSync(new URL("../../desktop/main.ts", import.meta.url), "utf8");
    const readyListener = source.indexOf('mainWindow.once("ready-to-show"');
    const loadRenderer = source.indexOf("await mainWindow.loadFile");
    const visibilityFallback = source.indexOf("if (!mainWindow.isVisible()) mainWindow.show()", loadRenderer);

    expect(readyListener).toBeGreaterThan(-1);
    expect(loadRenderer).toBeGreaterThan(readyListener);
    expect(visibilityFallback).toBeGreaterThan(loadRenderer);
  });
});
