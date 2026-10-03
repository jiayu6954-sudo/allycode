import { describe, expect, it, vi } from "vitest";
import { SettingsSchema } from "../src/config/schema.js";
import { classifyRisk } from "../src/permissions/classifier.js";
import { PermissionManager } from "../src/permissions/manager.js";

describe("smart permission policy", () => {
  it("publishes the agent checklist automatically without granting permission to execute its steps",async()=>{
    const prompt=vi.fn(async()=>"deny" as const);
    const manager=new PermissionManager(SettingsSchema.parse({defaultPermissions:{plan_update:"ask"},customRules:[{tool:"*",level:"ask"}]}),prompt,false);
    await expect(manager.request("plan_update",{items:[{step:"检查项目并拆解任务",status:"in_progress"}]})).resolves.toBe("allow");
    expect(prompt).not.toHaveBeenCalled();
    await expect(manager.request("bash",{command:"npm install"})).resolves.toBe("deny");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["rg --files", "safe"],
    ["Get-ChildItem -Recurse | Select-String TODO", "safe"],
    ["git status --short", "safe"],
    ["git diff -- src", "safe"],
    ["Get-Content E:\\outside\\secret.txt", "moderate"],
    ["Get-Content ..\\other-project\\README.md", "moderate"],
    ["npm install", "moderate"],
    ["Remove-Item build.tmp", "moderate"],
    ["curl https://example.com", "moderate"],
    ["git reset --hard", "dangerous"],
  ] as const)("classifies %s as %s", (command, expected) => {
    expect(classifyRisk("bash", { command })).toBe(expected);
  });

  it("auto-allows read-only inspection without a sandbox", async () => {
    const prompt = vi.fn(async () => "deny" as const);
    const manager = new PermissionManager(SettingsSchema.parse({}), prompt, false);

    await expect(manager.request("bash", { command: "rg --files" })).resolves.toBe("allow");
    await expect(manager.request("file_read", { path: "README.md" })).resolves.toBe("allow");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("asks for unknown or mutating commands", async () => {
    const prompt = vi.fn(async () => "allow" as const);
    const manager = new PermissionManager(SettingsSchema.parse({}), prompt, false);

    await expect(manager.request("bash", { command: "npm test" })).resolves.toBe("allow");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("always asks before first network access even if legacy settings say auto", async () => {
    const prompt = vi.fn(async () => "allow" as const);
    const settings = SettingsSchema.parse({
      defaultPermissions: { web_search: "auto" },
    });
    const manager = new PermissionManager(settings, prompt, false);

    await expect(manager.request("web_search", { query: "current docs" })).resolves.toBe("allow");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("applies allow-session to the same moderate tool instead of one exact input", async () => {
    const prompt = vi.fn(async () => "allow-session" as const);
    const manager = new PermissionManager(SettingsSchema.parse({}), prompt, false);

    await expect(manager.request("file_edit", { path: "a.ts" })).resolves.toBe("allow");
    await expect(manager.request("file_edit", { path: "b.ts" })).resolves.toBe("allow");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps task-scoped allowances across pause and resume managers", async () => {
    const shared = new Set<string>();
    const firstPrompt = vi.fn(async () => "allow-session" as const);
    const resumedPrompt = vi.fn(async () => "deny" as const);

    const firstRun = new PermissionManager(SettingsSchema.parse({}), firstPrompt, false, shared);
    await expect(firstRun.request("file_write", { path: "first.ts" })).resolves.toBe("allow");

    const resumedRun = new PermissionManager(SettingsSchema.parse({}), resumedPrompt, false, shared);
    await expect(resumedRun.request("file_write", { path: "second.ts" })).resolves.toBe("allow");
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(resumedPrompt).not.toHaveBeenCalled();
  });

  it("never reuses a session allowance for dangerous commands", async () => {
    const prompt = vi.fn(async () => "allow-session" as const);
    const manager = new PermissionManager(SettingsSchema.parse({}), prompt, false);

    await manager.request("bash", { command: "git reset --hard" });
    await manager.request("bash", { command: "git reset --hard HEAD~1" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
