import type { PermissionRequest } from "../../../src/types/permissions.js";

export interface PermissionPresentation {
  title: string;
  purpose: string;
  target: string;
  effect: string;
  taskAllowance: string;
}

/** Display-only descriptions. Never used to classify risk or grant permission. */
export function presentPermission(request: PermissionRequest, cwd: string): PermissionPresentation {
  const input = request.input as Record<string, unknown>;
  const value = (name: string) => typeof input[name] === "string" ? String(input[name]) : "";
  const result: PermissionPresentation = {
    title: "执行工具操作",
    purpose: "工具需要你的确认才能继续。",
    target: value("path") || value("name") || cwd || "当前项目",
    effect: "该工具可能读取或修改数据，请核对操作详情。",
    taskAllowance: `只对当前任务内同一工具（${request.toolName}）、相同风险等级生效；高风险操作仍单独询问。`,
  };
  switch (request.toolName) {
    case "document_format": {
      const data=input.request && typeof input.request === "object" ? input.request as Record<string,unknown> : {};
      const labels:Record<string,string>={status:"检查文档组件与公文字体",setup:"安装内置文档转换组件",build:"按公文规范生成 Word",word_to_pdf:"将 Word 转为 PDF",pdf_to_word:"将 PDF 重建为可编辑 Word"};
      Object.assign(result,{title:labels[value("action")]??"处理文档",purpose:"使用固定字号、行距、页边距和标题规范，并保留来源及转换限制。",target:String(data.output??data.path??cwd),effect:value("action")==="setup"?"联网下载 python-docx、pypdf 和官方 LibreOffice，保存到 AllyCode 文档组件目录。":"结果保存到当前项目的新文件，不覆盖原件。PDF 重建可能无法恢复原表格、图片或版式，会明确标注。",taskAllowance:"仅对当前任务、同一文档操作类型生效；生成文档与联网安装分别授权。"});break;
    }
    case "document_verify": Object.assign(result,{title:"校验 Word 报告",purpose:"重新打开文件，核对指定格式、必要文本和来源文件是否改变。",effect:"只读校验，不修改报告；不能替代数据核算与排版目视复核。"});break;
    case "vision_analyze": Object.assign(result,{title:value("action")==="status"?"检查本地视觉组件":"理解图片或解析扫描件",purpose:"在本机使用视觉模型读取当前项目资料，保留原图页码和证据。",effect:"会运行本地模型，并保存新的项目内 JSON 结果；提取内容可能进入云端主模型上下文。识别结果仍需核对。",taskAllowance:"仅对当前任务、同一视觉操作类型生效。"});break;
    case "sources_to_excel": {
      const data = input.request && typeof input.request === "object" ? input.request as Record<string,unknown> : {};
      const labels:Record<string,string>={status:"检查 Excel 组件",inspect:"查看资料清单与原文",setup:"安装 Excel 和 PDF 组件",scan:"扫描资料并建立来源清单",attach_ocr:"合并扫描件识别证据",build:"生成并校验 Excel"};
      Object.assign(result,{title:labels[value("action")] ?? "整理 Excel 资料",purpose:value("action")==="setup"?"为当前项目准备隔离运行环境，让 AllyCode 自动读资料、写表格。":"按当前任务读取资料、保留来源并生成可核对的结果。",target:String(data.output ?? data.manifest ?? cwd),effect:value("action")==="setup"?"会联网下载 openpyxl、pypdf 及依赖，安装到当前项目的 .allycode/tools 目录。":"读取的资料会进入当前任务模型上下文；生成结果保存在项目内，不覆盖已有 Excel。",taskAllowance:"仅对当前任务、同一文档操作类型生效；允许扫描不等于允许联网安装。"});break;
    }
    case "document_ocr": Object.assign(result,{title:value("action")==="status"?"检查本机文字识别能力":"识别图片或扫描 PDF 的文字",purpose:"在本机提取文字、页码和位置，供整理表格使用。",target:value("path") || cwd,effect:"原始图像由 Windows 本机识别；提取文字会进入当前任务模型上下文，并保存为项目内的证据文件。识别结果仍需核对。",taskAllowance:"仅对当前任务、同一 OCR 操作类型生效。"});break;
    case "file_write": Object.assign(result,{title:"写入项目文件",purpose:"保存生成的内容；如果文件已存在，将覆盖原内容。",effect:"会修改磁盘中的文件。",target:value("path")});break;
    case "file_edit": Object.assign(result,{title:"修改项目文件",purpose:"将指定片段替换为新的内容。",effect:"会修改文件中的匹配片段。",target:value("path")});break;
    case "file_read": Object.assign(result,{title:"读取项目文件",purpose:"查看文件内容以分析当前项目。",effect:"本次操作读取文件内容。",target:value("path")});break;
    case "bash": Object.assign(result,describeCommand(value("command")));break;
    case "service_start": Object.assign(result,{title:"启动项目服务",purpose:`启动「${value("name") || "项目服务"}」，供运行或验证使用。`,effect:"会启动持续运行的进程，可能占用端口；启动脚本也可能写入文件。"});break;
    case "service_stop": Object.assign(result,{title:"停止项目服务",purpose:input.all ? "停止当前项目管理的全部服务。" : `停止「${value("name") || "指定服务"}」。`,effect:"服务停止后，对应页面或接口将暂时无法访问。"});break;
    case "web_fetch": Object.assign(result,{title:"联网读取网页",purpose:"获取网页内容用于当前任务。",target:displayUrl(value("url")),effect:"会向该地址发起网络请求。"});break;
    case "web_search": Object.assign(result,{title:"联网搜索资料",purpose:"向搜索服务查询相关资料。",target:value("query"),effect:"搜索词会发送给配置的搜索服务。"});break;
    case "browser_verify": {
      const actions=Array.isArray(input.actions)?input.actions:[];
      const changes=actions.some(action=>action?.type==="click" || action?.type==="fill");
      Object.assign(result,{title:changes?"在浏览器中操作并验证页面":"用浏览器检查页面",purpose:changes?"填写内容、点击控件，并核对预期结果。":"打开页面，检查渲染结果和预期内容。",target:displayUrl(value("url")),effect:changes?"点击可能提交表单或改变网站数据，请展开详情核对具体操作。":"会访问页面并执行其网页脚本。"});break;
    }
    case "desktop_control": {
      const labels:Record<string,string>={click:"点击软件控件",type_text:"向软件输入文字",press_key:"向软件发送按键",inspect:"查看软件控件",screenshot:"查看软件窗口截图",list_windows:"查看打开的软件窗口",focus:"切换软件窗口"};
      Object.assign(result,{title:labels[value("action")] || "操作本机软件",purpose:"在指定软件窗口中执行操作。",target:`窗口 ${String(input.windowHandle ?? "列表")}`,effect:"操作作用于本机软件；输入或点击可能改变当前内容。",taskAllowance:"仅对当前任务、同一操作类型和同一窗口生效；高风险操作仍单独询问。"});break;
    }
    case "git_commit": Object.assign(result,{title:"保存 Git 版本记录",purpose:"将所选改动记录为一次本地提交。",effect:"会修改本地版本历史；此工具不负责推送。"});break;
    case "spawn_research": Object.assign(result,{title:"开展联网研究",purpose:"调用模型并搜索资料，整理当前问题。",effect:"可能产生额外模型费用并访问网络。"});break;
  }
  if(request.riskLevel==="dangerous")result.effect="此操作被判定为高风险。"+result.effect;
  return result;
}

function describeCommand(command: string): Partial<PermissionPresentation> {
  const trimmed=command.trim();
  // Complex scripts are deliberately not described as a harmless first command.
  if(/[;|&\r\n`<>$]/.test(trimmed))return {title:"执行多步终端脚本",purpose:"运行包含多条指令或重定向的脚本；完整动作需要核对展开的详情。",effect:"可能运行程序、改写文件或访问网络。不能仅凭第一条命令判断整个脚本。"};
  const npm=/^(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?([\w:-]+)(?:\s|$)/i.exec(trimmed);
  if(npm){
    const name=npm[1]!;
    if(["install","ci","add"].includes(name))return {title:"安装项目依赖",purpose:"安装项目运行或开发所需的软件包。",effect:"会联网下载软件包、写入依赖目录；安装脚本可能运行程序。"};
    const titles:Record<string,string>={test:"运行自动化测试","test:run":"运行自动化测试",typecheck:"检查代码类型",lint:"检查代码规范",build:"构建项目",dev:"启动开发预览",start:"启动项目"};
    return {title:titles[name] || `运行项目任务「${name}」`,purpose:`执行项目定义的「${name}」脚本。`,effect:"脚本按项目配置运行，可能生成文件、启动程序或访问网络。"};
  }
  if(/^(?:git\s+(?:status|diff|log)|Get-Content|Get-ChildItem|rg|cat|ls)(?:\s|$)/i.test(trimmed))return {title:"检查项目文件与状态",purpose:"查看文件、搜索内容或检查版本差异。",effect:"按详情中的命令及参数读取项目资料。"};
  if(/^(?:Remove-Item|rm|del|rmdir)(?:\s|$)/i.test(trimmed))return {title:"删除文件或目录",purpose:"删除命令中指定的文件或目录。请展开详情核对目标。",effect:"文件可能无法恢复，请确认目标无误。"};
  if(/^git\s+push(?:\s|$)/i.test(trimmed))return {title:"推送代码到远程仓库",purpose:"将本地提交发送至配置的远程仓库。",effect:"会联网并改变远程仓库。"};
  return {title:"运行终端程序",purpose:"执行当前项目所需的程序；未能自动识别完整用途，请查看操作详情。",effect:"可能修改文件、运行其他程序或访问网络。"};
}

function displayUrl(value:string):string {
  try {const url=new URL(value);return `${url.protocol}//${url.host}${url.pathname}`;} catch{return "请在操作详情中核对地址";}
}
