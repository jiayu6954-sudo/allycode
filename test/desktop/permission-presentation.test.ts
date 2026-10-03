import {describe,expect,it} from "vitest";
import {presentPermission} from "../../desktop/renderer/src/permission-presentation.js";
import type {PermissionRequest} from "../../src/types/permissions.js";

const describeRequest=(toolName:string,input:Record<string,unknown>,riskLevel:PermissionRequest["riskLevel"]="moderate")=>presentPermission({toolName,input,riskLevel,description:"untrusted generated description"},"D:\\project");
describe("plain language permission card",()=>{
  it("describes document installation and OCR data flow without exposing commands",()=>{
    const setup=describeRequest("sources_to_excel",{action:"setup"});
    expect(setup.title).toBe("安装 Excel 和 PDF 组件");expect(setup.effect).toContain("联网下载");expect(setup.taskAllowance).toContain("允许扫描不等于");
    const ocr=describeRequest("document_ocr",{action:"recognize",path:"资料/扫描件.pdf"});
    expect(ocr.target).toBe("资料/扫描件.pdf");expect(ocr.effect).toContain("当前任务模型上下文");
  });
  it.each([["npm.cmd run build","构建项目"],["npm test","运行自动化测试"],["npm ci","安装项目依赖"],["npm run typecheck","检查代码类型"]])("describes %s without putting source code in the headline",(command,title)=>{
    const view=describeRequest("bash",{command});expect(view.title).toBe(title);expect(view.target).toBe("D:\\project");expect(view.effect).not.toContain("不会");
  });
  it("does not disguise a compound command behind a harmless first operation",()=>{
    const view=describeRequest("bash",{command:"npm test; Remove-Item data -Recurse"},"dangerous");
    expect(view.title).toBe("执行多步终端脚本");expect(view.effect).toContain("高风险");
  });
  it("shows the affected file and acknowledges overwrite behavior",()=>{
    const view=describeRequest("file_write",{path:"src/main.ts",content:"code"});
    expect(view.target).toBe("src/main.ts");expect(view.purpose).toContain("覆盖");expect(JSON.stringify(view)).not.toContain("untrusted generated");
  });
  it("discloses browser interaction side effects and limits URLs to their destination",()=>{
    const view=describeRequest("browser_verify",{url:"https://user:secret@example.com/save?token=private",actions:[{type:"click",selector:"button"}]},"dangerous");
    expect(view.effect).toContain("提交表单");expect(view.target).toBe("https://example.com/save");
  });
  it("does not pretend unknown scripts have been interpreted",()=>{
    const view=describeRequest("bash",{command:"python custom_script.py"});
    expect(view.purpose).toContain("未能自动识别");expect(view.effect).toContain("修改文件");
  });
});
