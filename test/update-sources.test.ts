import { describe, expect, it } from "vitest";
import { normalizeSources } from "../desktop/update-sources.js";

describe("domestic update sources", () => {
  it("accepts only unique HTTPS origins and preserves primary/mirror order", () => {
    expect(normalizeSources([
      "https://download.example.cn/allycode/alpha/",
      "http://insecure.example.cn/alpha",
      "https://mirror.example.cn/allycode/alpha",
      "https://download.example.cn/allycode/alpha",
      "not-a-url",
    ])).toEqual([
      "https://download.example.cn/allycode/alpha",
      "https://mirror.example.cn/allycode/alpha",
    ]);
  });
});
