import fs from "node:fs/promises";
import path from "node:path";
import {executeDocumentFormat} from "../src/tools/document-format.js";
import {executeDocumentVerify} from "../src/tools/document-verify.js";
const ctx={cwd:path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".tmp/document-live"),timeoutMs:120000};
await fs.mkdir(ctx.cwd,{recursive:true});
if(process.argv.includes("--setup")){console.log((await executeDocumentFormat({action:"setup"},ctx)).content);process.exit(0);}
await fs.writeFile(path.join(ctx.cwd,"source.csv"),"项目,数量\n甲,12\n乙,8\n");
const request={output:"公文格式测试.docx",sources:["source.csv"],title:"关于文档转换组件验证的报告",summary:"本报告用于检验固定格式与格式转换功能。样例合计 20 条，仅为软件回归数据。",sections:[
  {heading:"验证范围",paragraphs:["以源表的 12 条和 8 条记录为依据，合计为 20 条。固定字号、行距和页边距应能保持一致。"],tables:[{headers:["项目","数量"],rows:[["甲","12"],["乙","8"],["合计","20"]]}]},
  {heading:"格式检查",level:2,paragraphs:["检查二级标题楷体、三号和加粗。字体缺失应明确标注。"]},
  {heading:"三级标题",level:3,paragraphs:["检查仿宋三号加粗。"]},
  {heading:"四级标题",level:4,paragraphs:["检查四级编号与字体。"]},
],attachments:["回归验证清单","来源记录"],issuer:"AllyCode 验证组",date:"2026年9月21日",contact:"联系人：测试人员"};
const build=await executeDocumentFormat({action:"build",request},ctx);
console.log(build.content);
const verify=await executeDocumentVerify({path:request.output,sources:["source.csv"],expectedText:["合计为 20 条","回归验证清单"],minTables:1},ctx);
console.log(verify.content);
console.log((await executeDocumentFormat({action:"word_to_pdf",request:{path:request.output,output:"公文格式测试.pdf"}},ctx)).content);
console.log((await executeDocumentFormat({action:"pdf_to_word",request:{path:"公文格式测试.pdf",output:"往返可编辑稿.docx"}},ctx)).content);
