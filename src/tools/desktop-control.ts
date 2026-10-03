import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolExecutionContext, ToolResult } from "../types/tools.js";
import { resolveWorkspacePath } from "./path-guard.js";
import { sourcesExcelDirectory } from "../skills/bundled.js";
import { documentProcess } from "./local-document-process.js";

export const DesktopControlSchema = z.object({
  action: z.enum(["list_windows", "inspect", "invoke", "set_value", "hotkey", "screenshot"]),
  windowHandle: z.number().int().positive().optional(),
  targetId: z.string().regex(/^-?\d+(?:\.-?\d+)*$/).max(240).optional(),
  value: z.string().max(12000).optional(),
  key: z.enum(["ENTER", "TAB", "ESC", "CTRL+S", "CTRL+A", "CTRL+C", "CTRL+V", "CTRL+Z", "ALT+F4"]).optional(),
}).superRefine((input, ctx) => {
  if (input.action !== "list_windows" && !input.windowHandle) ctx.addIssue({code:"custom",message:"First list windows and provide its observed windowHandle."});
  if (["invoke", "set_value"].includes(input.action) && !input.targetId) ctx.addIssue({code:"custom",message:"First inspect the window and provide its observed targetId."});
  if (input.action === "set_value" && input.value === undefined) ctx.addIssue({code:"custom",message:"set_value requires value."});
  if (input.action === "hotkey" && !input.key) ctx.addIssue({code:"custom",message:"hotkey requires key."});
});

// Input is JSON over stdin; user text is never interpolated into executable code.
export const WINDOWS_DESKTOP_BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AllyDesktopNative {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
try {
 if ($request.action -eq 'list_windows') {
  $items = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
   try { if ($_.Current.NativeWindowHandle -ne 0) { @{windowHandle=$_.Current.NativeWindowHandle;title=$_.Current.Name;processId=$_.Current.ProcessId} } } catch {}
  })
  @{ok=$true;windows=$items} | ConvertTo-Json -Depth 5 -Compress
  exit 0
 }
 $window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$request.windowHandle)
 if (-not $window) { throw 'Window no longer exists. List windows again.' }
 $windowInfo = @{windowHandle=$request.windowHandle;title=$window.Current.Name;processId=$window.Current.ProcessId}
 if ($request.action -eq 'screenshot') {
  $rect=$window.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0 -or $rect.Width -gt 10000 -or $rect.Height -gt 10000) { throw 'Window cannot be captured.' }
  if (-not [AllyDesktopNative]::SetForegroundWindow([IntPtr]$request.windowHandle)) { throw 'Cannot focus window.' }
  Start-Sleep -Milliseconds 150
  if ([AllyDesktopNative]::GetForegroundWindow().ToInt64() -ne $request.windowHandle) { throw 'Foreground changed. No screenshot taken.' }
  $bmp=New-Object System.Drawing.Bitmap([int]$rect.Width,[int]$rect.Height)
  $graphics=[System.Drawing.Graphics]::FromImage($bmp)
  try { $graphics.CopyFromScreen([int]$rect.X,[int]$rect.Y,0,0,$bmp.Size); $bmp.Save($request.outputPath,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bmp.Dispose() }
  @{ok=$true;window=$windowInfo;artifact=$request.outputPath} | ConvertTo-Json -Depth 5 -Compress
  exit 0
 }
 if ($request.action -eq 'hotkey') {
  $keys=@{'ENTER'='{ENTER}';'TAB'='{TAB}';'ESC'='{ESC}';'CTRL+S'='^s';'CTRL+A'='^a';'CTRL+C'='^c';'CTRL+V'='^v';'CTRL+Z'='^z';'ALT+F4'='%{F4}'}
  if (-not $keys.ContainsKey($request.key)) { throw 'Unsupported key.' }
  if (-not [AllyDesktopNative]::SetForegroundWindow([IntPtr]$request.windowHandle)) { throw 'Cannot focus window.' }
  Start-Sleep -Milliseconds 100
  if ([AllyDesktopNative]::GetForegroundWindow().ToInt64() -ne $request.windowHandle) { throw 'Foreground changed. Key was not sent.' }
  [System.Windows.Forms.SendKeys]::SendWait($keys[$request.key])
  @{ok=$true;window=$windowInfo;action=$request.action;requiresVerification=$true} | ConvertTo-Json -Depth 5 -Compress
  exit 0
 }
 $queue=New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
 $queue.Enqueue($window)
 $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
 $items=New-Object System.Collections.ArrayList
 $target=$null
 $count=0
 while ($queue.Count -gt 0 -and $count -lt 300) {
  $element=$queue.Dequeue(); $count++
  try {
   $id=($element.GetRuntimeId() -join '.')
   if ($id -eq $request.targetId) { $target=$element }
   $secret=$element.Current.IsPassword
   [void]$items.Add(@{targetId=$id;name=$(if($secret){'[password field]'}else{$element.Current.Name});type=$element.Current.ControlType.ProgrammaticName;enabled=$element.Current.IsEnabled;offscreen=$element.Current.IsOffscreen})
   $child=$walker.GetFirstChild($element)
   while ($child -and $queue.Count -lt 300) { $queue.Enqueue($child); $child=$walker.GetNextSibling($child) }
  } catch {}
 }
 if ($request.action -eq 'inspect') {
  @{ok=$true;window=$windowInfo;controls=@($items);truncated=($queue.Count -gt 0)} | ConvertTo-Json -Depth 6 -Compress
  exit 0
 }
 if (-not $target) { throw 'Control changed or was not found. Inspect again.' }
 if ($target.Current.IsPassword) { throw 'Enter passwords manually in the application.' }
 if (-not $target.Current.IsEnabled -or $target.Current.IsOffscreen) { throw 'Control is disabled or offscreen.' }
 if ($request.action -eq 'set_value') {
  $pattern=$target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($pattern.Current.IsReadOnly) { throw 'Control is read only.' }
  $pattern.SetValue([string]$request.value)
 } elseif ($request.action -eq 'invoke') {
  $pattern=$target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
 } else { throw 'Unsupported action.' }
 @{ok=$true;window=$windowInfo;action=$request.action;targetId=$request.targetId;requiresVerification=$true} | ConvertTo-Json -Depth 5 -Compress
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
`;

export async function executeDesktopControl(raw: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const input = DesktopControlSchema.parse(raw);
  if (!["win32","linux"].includes(process.platform)) return {content:"此平台尚未适配内置电脑操作。",isError:true};
  if (context.signal?.aborted) return {content:"电脑操作已取消。",isError:true};
  let outputPath: string | undefined;
  if (input.action === "screenshot") {
    const directory = resolveWorkspacePath(context.cwd, ".allycode-eval/desktop");
    await fs.mkdir(directory, {recursive:true});
    outputPath = path.join(directory, `${Date.now()}.png`);
  }
  if(process.platform === "linux") {
    try {
      const content=await documentProcess("/usr/bin/python3",["-I",path.join(sourcesExcelDirectory(),"scripts/linux_desktop.py")],context,JSON.stringify({...input,outputPath}),20000);
      return {content,isError:false};
    } catch(error) {return {content:`Linux 电脑操作失败：${String(error)}。请确认已登录桌面并在开始设置中安装无障碍组件。`,isError:true};}
  }
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_DESKTOP_BRIDGE,"utf16le").toString("base64")], {cwd:context.cwd,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let stdout="", stderr="", settled=false;
    const finish=(result:ToolResult)=>{if(settled)return;settled=true;clearTimeout(timer);context.signal?.removeEventListener("abort",abort);resolve(result);};
    const abort=()=>{child.kill();finish({content:"电脑操作已中止；请重新检查目标窗口后再决定下一步。",isError:true});};
    const timer=setTimeout(abort,20000);
    context.signal?.addEventListener("abort",abort,{once:true});
    child.stdout.on("data",chunk=>{stdout+=String(chunk);if(stdout.length>100000)abort();});
    child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-3000);});
    child.on("error",error=>finish({content:error.message,isError:true}));
    child.on("close",code=>finish({content:stdout.trim() || stderr || "电脑操作未返回结果。",isError:code!==0,metadata:{exitCode:code??undefined}}));
    child.stdin.on("error",()=>{});
    child.stdin.end(JSON.stringify({...input,outputPath}));
  });
}
