import path from "node:path";
import { z } from "zod";

export const PluginPermissionSchema = z.enum([
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:access",
  "secrets:read",
  "memory:read",
  "memory:write",
  "ui:extend",
]);

export const AllyCodePluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(3).max(96).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().trim().min(1).max(500),
  kind: z.enum([
    "tool",
    "skill",
    "model-provider",
    "agent-engine",
    "computer-use",
    "evaluator",
  ]),
  entrypoint: z.string().trim().min(1).max(260),
  permissions: z.array(PluginPermissionSchema).max(16).default([]),
  engines: z.array(z.enum(["native", "codex", "deepseek-harness"])).min(1).default(["native"]),
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  publisher: z.object({
    name: z.string().trim().min(1).max(120),
    website: z.string().url().optional(),
  }).optional(),
}).superRefine((manifest, ctx) => {
  if (path.posix.isAbsolute(manifest.entrypoint) || path.win32.isAbsolute(manifest.entrypoint) || /^[A-Za-z]:/.test(manifest.entrypoint)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entrypoint"],
      message: "插件入口必须是插件目录内的相对路径",
    });
  }
  const normalized = path.posix.normalize(manifest.entrypoint.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entrypoint"],
      message: "插件入口不能逃逸插件目录",
    });
  }
  if (manifest.kind === "computer-use" && !manifest.permissions.includes("ui:extend")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["permissions"],
      message: "computer-use 插件必须声明 ui:extend 权限",
    });
  }
});

export type AllyCodePluginManifest = z.infer<typeof AllyCodePluginManifestSchema>;

export interface PluginTrustDecision {
  allowed: boolean;
  requiresUserApproval: boolean;
  reasons: string[];
}

export function evaluatePluginTrust(manifest: AllyCodePluginManifest): PluginTrustDecision {
  const highRisk = manifest.permissions.filter((permission) =>
    ["workspace:write", "process:execute", "network:access", "secrets:read", "ui:extend"].includes(permission)
  );
  const reasons: string[] = [];
  if (!manifest.integrity) reasons.push("插件没有声明 SHA-256 完整性摘要");
  if (!manifest.publisher) reasons.push("插件没有发布者信息");
  if (highRisk.length > 0) reasons.push(`插件申请高风险权限：${highRisk.join("、")}`);
  return {
    allowed: !manifest.permissions.includes("secrets:read") || Boolean(manifest.integrity && manifest.publisher),
    requiresUserApproval: highRisk.length > 0 || !manifest.integrity,
    reasons,
  };
}

export function resolvePluginEntrypoint(pluginRoot: string, manifest: AllyCodePluginManifest): string {
  const root = path.resolve(pluginRoot);
  const resolved = path.resolve(root, manifest.entrypoint);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("插件入口超出插件目录。 ");
  }
  return resolved;
}
