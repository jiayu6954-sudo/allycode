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
    case "session_search":
      return "safe";

    case "web_fetch":
      return "safe";

    default:
      return "moderate";
  }
}

export function describeAction(toolName: string, input: ToolInput | Record<string, unknown>): string {
  switch (toolName) {
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
    case "session_search":
      return `搜索项目历史：${String((input as Record<string, unknown>)["query"] ?? "")}`;
    case "spawn_research":
      return "执行联网深度研究";
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
