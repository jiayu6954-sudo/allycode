import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, expect, it} from "vitest";
import {executeSourcesExcel, findPython} from "../../src/tools/sources-to-excel.js";
import {documentProcess} from "../../src/tools/local-document-process.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"ally-formula-"));roots.push(cwd);
 await fs.writeFile(path.join(cwd,"source.txt"),"商品A 数量 3 单价 100 成本 60 店铺 甲；商品B 数量 2 单价 80 成本 50 店铺 乙；原文 =SUM(1,2)\n");
 const ctx={cwd,timeoutMs:120000};await executeSourcesExcel({action:"scan",request:{inputs:["source.txt"],output:"scan/manifest.json"}},ctx);
 const manifest=JSON.parse(await fs.readFile(path.join(cwd,"scan/manifest.json"),"utf8")),id=manifest.files[0].id;
 const ev=(quote:string)=>[{file_id:id,locator:"line:1",quote}];
 const formula=(expression:string,expected:string)=>({formula:expression,expected,resultType:"decimal",explanation:"测试中用固定原始数值独立计算预期值"});
 const columns=[{key:"item",header:"商品",type:"text"},{key:"qty",header:"数量",type:"integer"},{key:"price",header:"单价",type:"decimal"},{key:"cost",header:"成本",type:"decimal"},{key:"sales",header:"销售额",type:"formula"},{key:"profit",header:"毛利额",type:"formula"}];
 const rows=[{item:"商品A",qty:"3",price:"100",cost:"60",sales:formula("=B2*C2","300"),profit:formula("=ROUND(E2-B2*D2,2)","120")},{item:"商品B",qty:"2",price:"80",cost:"50",sales:formula("=B3*C3","160"),profit:formula("=ROUND(E3-B3*D3,2)","60")}].map(values=>({values,evidence:Object.fromEntries(columns.map(c=>[c.key,ev(typeof values[c.key as keyof typeof values]==="string"?String(values[c.key as keyof typeof values]):"数量")]))}));
 const request={manifest:"scan/manifest.json",output:"结果/行业计算.xlsx",coverage:{[id]:{status:"included"}},sheets:[{name:"经营明细",columns,rows}]};
 return {ctx,request,formula,ev};
}

it("calculates financial/e-commerce formulas, cross-sheet summaries and lookups, preserving literal text",async()=>{
 const {ctx,request,formula,ev}=await fixture();
 const expressions=[
  ["SUM", "=SUM('经营明细'!E2:E3)","460"],
  ["SUMIF", "=SUMIF('经营明细'!A2:A3,\"商品A\",'经营明细'!E2:E3)","300"],
  ["SUMIFS", "=SUMIFS('经营明细'!E2:E3,'经营明细'!B2:B3,\">2\")","300"],
  ["COUNTIF", "=COUNTIF('经营明细'!B2:B3,\">1\")","2"],
  ["IFERROR", "=IFERROR(1/0,0)","0"],
  ["VLOOKUP", "=VLOOKUP(\"商品B\",'经营明细'!A2:F3,5,FALSE)","160"],
  ["INDEX MATCH", "=INDEX('经营明细'!E2:E3,MATCH(\"商品A\",'经营明细'!A2:A3,0))","300"],
  ["XLOOKUP", "=XLOOKUP(\"商品B\",'经营明细'!A2:A3,'经营明细'!E2:E3,0)","160"],
  ["margin", "=ROUND(SUM('经营明细'!F2:F3)/SUM('经营明细'!E2:E3),6)","0.391304"],
 ];
 const summary={name:"统计指标",columns:[{key:"label",header:"原文备注",type:"text"},{key:"computed",header:"计算结果",type:"formula"}],rows:[...expressions.map(([,expression,expected])=>({values:{label:"=SUM(1,2)",computed:formula(expression!,expected!)},evidence:{label:ev("=SUM(1,2)"),computed:ev("数量")}})),
 {values:{label:"=SUM(1,2)",computed:{...formula('=IF(1=1,"","other")',""),resultType:"text"}},evidence:{label:ev("=SUM(1,2)"),computed:ev("数量")}},
 {values:{label:"=SUM(1,2)",computed:{...formula('=AND(1=1,2>1)',""),expected:true,resultType:"boolean"}},evidence:{label:ev("=SUM(1,2)"),computed:ev("数量")}},
 ]};
 const result=await executeSourcesExcel({action:"build",request:{...request,sheets:[...request.sheets,summary]}},ctx);
 expect(JSON.parse(result.content).formulas).toMatchObject({status:"recalculated_and_verified",count:15});
 const python=await findPython(ctx);if(!python?.ready)throw new Error("missing Python");
 const values=JSON.parse(await documentProcess(python.command,[...python.args,"-I","-X","utf8","-c","import json,sys;from openpyxl import load_workbook;a=load_workbook(sys.argv[1],data_only=True);b=load_workbook(sys.argv[1],data_only=False);print(json.dumps({'cache':a['经营明细']['E2'].value,'formula':b['经营明细']['E2'].value,'literal':b['统计指标']['A2'].value,'literalType':b['统计指标']['A2'].data_type}));a.close();b.close()",request.output],ctx));
 expect(values).toEqual({cache:300,formula:"=B2*C2",literal:"=SUM(1,2)",literalType:"s"});
},120000);

it.each(["wrong_result","division_by_zero","external","cycle","missing_ref"])("does not publish unverified formulas: %s",async kind=>{
 const {ctx,request}=await fixture();
 const f=request.sheets[0]!.rows[0]!.values.sales;
 if(kind==="wrong_result")f.expected="999";
 if(kind==="division_by_zero")f.formula="=1/0";
 if(kind==="external")f.formula="=WEBSERVICE(\"https://example.com\")";
 if(kind==="cycle")f.formula="=F2";
 if(kind==="missing_ref")f.formula="=Z999";
 await expect(executeSourcesExcel({action:"build",request},ctx)).rejects.toThrow();
 await expect(fs.access(path.join(ctx.cwd,request.output))).rejects.toThrow();
 await expect(fs.access(path.join(ctx.cwd,request.output+".audit.json"))).rejects.toThrow();
},120000);
