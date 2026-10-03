import {describe,it,expect} from "vitest";
import {execFileSync} from "node:child_process";
import {DesktopControlSchema,WINDOWS_DESKTOP_BRIDGE} from "../../src/tools/desktop-control.js";
import {SettingsSchema} from "../../src/config/schema.js";
import {PermissionManager} from "../../src/permissions/manager.js";
describe("embedded desktop tool",()=>{
  it("requires observed window and control IDs and rejects unbounded key expressions",()=>{
    expect(()=>DesktopControlSchema.parse({action:"invoke"})).toThrow();
    expect(()=>DesktopControlSchema.parse({action:"set_value",windowHandle:123,targetId:"1.2"})).toThrow();
    expect(()=>DesktopControlSchema.parse({action:"hotkey",windowHandle:123,key:"arbitrary code"})).toThrow();
    expect(DesktopControlSchema.parse({action:"set_value",windowHandle:123,targetId:"42.-2.3",value:"literal $x; `text`"}).value).toContain("$x");
  });
  it("scopes saved desktop authorization to action and window",async()=>{
    let prompts=0;
    const settings=SettingsSchema.parse({defaultPermissions:{desktop_control:"auto"}});
    const manager=new PermissionManager(settings,async()=>{prompts++;return "allow-session";});
    await manager.request("desktop_control",{action:"inspect",windowHandle:11});
    await manager.request("desktop_control",{action:"inspect",windowHandle:11});
    expect(prompts).toBe(1);
    await manager.request("desktop_control",{action:"inspect",windowHandle:12});
    expect(prompts).toBe(2);
    await manager.request("desktop_control",{action:"invoke",windowHandle:11,targetId:"1"});
    await manager.request("desktop_control",{action:"invoke",windowHandle:11,targetId:"1"});
    expect(prompts).toBe(4);
    expect(await PermissionManager.createReadOnly(settings).request("desktop_control",{action:"invoke",windowHandle:11,targetId:"1"})).toBe("deny");
  });
  it.skipIf(process.platform!=="win32")("parses the packaged PowerShell bridge without executing desktop actions",()=>{
    const encoded=Buffer.from(WINDOWS_DESKTOP_BRIDGE,"utf8").toString("base64");
    const script=`$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')),[ref]$t,[ref]$e); if($e.Count){ $e | ForEach-Object { $_.Message }; exit 1 }`;
    expect(()=>execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout:10000})).not.toThrow();
  });
});
