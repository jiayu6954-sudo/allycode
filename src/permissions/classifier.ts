import type { ToolInput, BashInput, FileWriteInput } from "../types/tools.js";
import type { RiskLevel } from "../types/permissions.js";

// Patterns that indicate a dangerous bash command
const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /rm\s+(-[rRf]{1,3}|--recursive|--force)/i,
  /:\s*\(\s*\)\s*\{\s*:\|:\s*&\s*\}/,     // fork bomb
  /dd\s+if=/,
  /mkfs\./,
  />\s*\/dev\/sd[a-z]/,
  /chmod\s+-R\s+777/,
  /curl[^|]*\|\s*(ba?sh|sh|zsh)/i,
  /wget[^|]*\|\s*(ba?sh|sh|zsh)/i,
  /eval\s*\(/,
  /shutdown|reboot|halt/,
  /pkill|killall/,
  /DROP\s+TABLE|DROP\s+DATABASE/i,
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[^\s]*f[^\s]*/i,
  /Remove-Item\b(?=[^\n]*(?:-Recurse))(?=[^\n]*(?:-Force))/i,
  /(?:Format-Volume|Clear-Disk|Initialize-Disk|Stop-Computer|Restart-Computer)\b/i,
];

// Patterns that are moderately risky
const MODERATE_BASH_PATTERNS: RegExp[] = [
  /rm\s+/,
  /mv\s+/,
  /cp\s+-r/i,
  /chmod\s+/,
  /chown\s+/,
  /sudo\s+/,
  /npm\s+(install|uninstall|publish)/,
  /yarn\s+(add|remove|publish)/,
  /pip\s+(install|uninstall)/,
  /apt(-get)?\s+(install|remove|purge)/,
  /git\s+(commit|push|merge|rebase|reset)/,
  /docker\s+(rm|rmi|stop|kill)/,
  /\b(?:Remove-Item|Move-Item|Rename-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item)\b/i,
  /\b(?:del|erase|rmdir|rd)\b/i,
  /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i,
  /\b(?:cmd|powershell|pwsh)\s+(?:\/c|-Command)\b/i,
  /\b(?:node|python|python3)\s+(?:-e|-c)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:run|test|exec|install|add|remove|uninstall|publish)\b/i,
  /\b(?:pytest|vitest|jest|cargo|go\s+test|dotnet\s+(?:test|build))\b/i,
  /git\s+(?:checkout|switch|restore|clean)\b/i,
  /find\b[^\n]*(?:-delete|-exec)\b/i,
];

const SAFE_BASH_SEGMENTS: RegExp[] = [
  /^\s*(?:pwd|ls|dir|Get-ChildItem|gci)(?:\s|$)/i,
  /^\s*(?:cat|type|Get-Content|gc|head|tail)(?:\s|$)/i,
  /^\s*(?:rg|grep|findstr|Select-String)(?:\s|$)/i,
  /^\s*(?:find|where|where\.exe|which)(?:\s|$)/i,
  /^\s*(?:Test-Path|Resolve-Path|Get-Item|Get-Process)(?:\s|$)/i,
  /^\s*(?:Select-Object|Sort-Object|Measure-Object|Format-Table|Format-List|Out-String)(?:\s|$)/i,
  /^\s*(?:wc|stat|file)(?:\s|$)/i,
  /^\s*git\s+(?:status|diff|log|show|rev-parse|ls-files|grep|describe)(?:\s|$)/i,
  /^\s*git\s+branch\s+--show-current\s*$/i,
  /^\s*git\s+remote\s+-v\s*$/i,
  /^\s*git\s+submodule\s+status\s*$/i,
  /^\s*(?:node|npm|pnpm|yarn|python|python3|git|docker|tsc)\s+--?version\s*$/i,
  /^\s*npm\s+(?:list|ls)(?:\s|$)/i,
  /^\s*docker\s+(?:ps|images|inspect|logs|version)(?:\s|$)/i,
  /^\s*(?:echo|Write-Output)\b/i,
];

// Safe-looking system paths that should never be written to
const PROTECTED_WRITE_PATHS = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/boot/",
  "/sys/",
  "/proc/",
  "C:\\Windows\\",
  "C:\\Program Files",
];

export function classifyRisk(toolName: string, input: ToolInput | Record<string, unknown>): RiskLevel {
  switch (toolName) {
    case "document_verify": return "safe";
    case "document_format": return (input as Record<string,unknown>).action === "status" ? "safe" : "moderate";
    case "sources_to_excel":
    case "vision_analyze":
    case "document_ocr": return ["status","inspect"].includes(String((input as Record<string, unknown>).action)) ? "safe" : "moderate";
    case "desktop_control": return ["list_windows", "inspect"].includes(String((input as Record<string, unknown>).action)) ? "moderate" : "dangerous";
    case "bash": {
      const cmd = (input as BashInput).command;
      if (DANGEROUS_BASH_PATTERNS.some((p) => p.test(cmd))) return "dangerous";
      if (MODERATE_BASH_PATTERNS.some((p) => p.test(cmd))) return "moderate";
      return isReadOnlyCommand(cmd) ? "safe" : "moderate";
    }

    case "file_write": {
      const p = (input as FileWriteInput).path;
      if (PROTECTED_WRITE_PATHS.some((prefix) => p.startsWith(prefix))) {
        return "dangerous";
      }
      return "moderate";
    }

    case "file_edit":
      return "moderate";

    case "file_read":
    case "glob":
    case "grep":
    case "evidence_read":
    case "session_search":
    case "plan_update":
    case "verification_status":
    case "phase_checkpoint":
      return "safe";

    case "web_fetch":
      return "safe";

    // Reading service state and shutting a service down are recovery actions.
    // Gating them behind a prompt is what leaks orphaned servers and held ports.
    case "service_status":
    case "service_stop":
      return "safe";

    case "service_start": {
      const cmd = String((input as Record<string, unknown>)["command"] ?? "");
      if (DANGEROUS_BASH_PATTERNS.some((p) => p.test(cmd))) return "dangerous";
      return "moderate";
    }

    // Verifying a page the agent itself is serving stays inside the project
    // boundary; any other origin is real network egress and needs a decision.
    case "browser_verify": {
      const actions = (input as Record<string, unknown>)["actions"];
      if (Array.isArray(actions) && actions.some((action: {type?: string}) => action.type === "click" || action.type === "fill")) return "dangerous";
      return isLoopbackUrl(String((input as Record<string, unknown>)["url"] ?? ""))
        ? "safe"
        : "moderate";
    }

    default:
      return "moderate";
  }
}

/** True for URLs served by this machine — the only ones verification auto-allows. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (!/^https?:$/.test(protocol)) return false;
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "0.0.0.0"
      || host === "::1"
      || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function describeAction(toolName: string, input: ToolInput | Record<string, unknown>): string {
  switch (toolName) {
    case "document_format": return (input as Record<string,unknown>).action === "setup" ? "下载并安装文档组件到 AllyCode 组件目录，用于 Word 生成及 Word/PDF 转换" : "按内置公文规范生成或转换文档，保存到当前项目目录，并记录转换限制";
    case "document_verify": return `检查 Word 报告能否读取、关键内容是否齐全及来源是否改变：${String((input as Record<string,unknown>).path)}`;
    case "vision_analyze": return (input as Record<string,unknown>).action === "status" ? "检查本地视觉组件" : `在本机分析图片或扫描件：${String((input as Record<string,unknown>).path)}；结果进入当前任务上下文，并保存项目内证据。`;
    case "sources_to_excel": {
      const data = input as Record<string, unknown>;
      const request = data.request as Record<string, unknown> | undefined;
      const labels: Record<string,string> = { status: "检查 Excel 运行组件", inspect: "分页查看资料清单与原文", setup: "联网下载 Excel/PDF 组件，安装到当前项目的隔离 Python 环境", scan: "扫描项目资料并生成来源清单", attach_ocr: "将本地 OCR 证据追加到资料清单", build: "生成 Excel 和来源审计文件，并重新打开校验" };
      return `${labels[String(data.action)] ?? "处理 Excel 资料"}${request?.output ? `：${String(request.output)}` : ""}`;
    }
    case "document_ocr": return (input as Record<string,unknown>).action === "status" ? "检查本机 OCR 语言与可用性" : `在本机识别图片或扫描件文字：${String((input as Record<string,unknown>).path)}；识别文字将进入当前任务模型上下文。`;
    case "desktop_control": return `电脑操作：${String((input as Record<string, unknown>).action)}；窗口 ${String((input as Record<string, unknown>).windowHandle ?? "窗口列表")}。该操作作用于本机软件。`;
    case "bash":
      return `运行命令：${(input as BashInput).command}`;
    case "file_read":
      return `读取文件：${(input as { path: string }).path}`;
    case "file_write":
      return `写入文件：${(input as FileWriteInput).path}`;
    case "file_edit":
      return `编辑文件：${(input as { path: string }).path}`;
    case "glob":
      return `查找文件：${(input as { pattern: string }).pattern}`;
    case "grep":
      return `搜索代码：${(input as { pattern: string }).pattern}`;
    case "web_fetch":
      return `联网读取：${(input as { url: string }).url}`;
    case "web_search":
      return `联网搜索：${String((input as Record<string, unknown>)["query"] ?? "")}`;
    case "evidence_read":
    case "session_search":
      return `搜索项目历史：${String((input as Record<string, unknown>)["query"] ?? "")}`;
    case "plan_update":
      return "更新当前任务计划";
    case "spawn_research":
      return "执行联网深度研究";
    case "service_start":
      return `启动常驻服务「${String((input as Record<string, unknown>)["name"] ?? "")}」：${String((input as Record<string, unknown>)["command"] ?? "")}`;
    case "service_status":
      return "查看常驻服务状态与日志";
    case "service_stop":
      return (input as Record<string, unknown>)["all"] === true
        ? "停止本项目全部常驻服务"
        : `停止常驻服务「${String((input as Record<string, unknown>)["name"] ?? "")}」`;
    case "browser_verify":
      return `真实浏览器验证页面：${String((input as Record<string, unknown>)["url"] ?? "")}`;
    default:
      return `执行工具：${toolName as string}`;
  }
}

function isReadOnlyCommand(command: string): boolean {
  // Shell expansion, redirection, and script blocks can hide mutations. Keep
  // them behind an approval even when the first visible command looks safe.
  if (/[`$%><{}]/.test(command)) return false;
  // Absolute, UNC, home-relative, or parent-relative paths may escape the
  // selected project. They require a user decision even for read commands.
  if (/(?:^|\s)["']?(?:[a-z]:[\\/]|\\\\|~[\\/])/i.test(command)) return false;
  if (/(?:^|[\s\\/])\.\.(?:[\\/]|\s|$)/.test(command)) return false;
  if (
    process.platform !== "win32" &&
    /(?:^|\s)["']?\/(?!\/)/.test(command)
  ) return false;
  const segments = splitShellSegments(command);
  return segments.length > 0 && segments.every((segment) =>
    SAFE_BASH_SEGMENTS.some((pattern) => pattern.test(segment))
  );
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if ((char === "'" || char === '"') && command[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }
    if (!quote && (char === ";" || char === "|" || char === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      while (command[index + 1] === char) index++;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}
