/** Read-only telemetry for local trials. Never reads settings, keys or private continuation files. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const data = process.env.ALLYCODE_DATA_DIR || path.join(os.homedir(), ".allycode");
const databasePath = path.join(data, "agent-state.sqlite");
const output = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : ".tmp/live-monitor/latest.json");
const watch = process.argv.includes("--watch");
const redact = (text) => String(text ?? "").replace(/sk-[\w-]+|Bearer\s+\S+|(?:api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "[已隐藏]").slice(0, 300);
function snapshot() {
  if (!fs.existsSync(databasePath)) return { generatedAt: new Date().toISOString(), status: "waiting_for_first_task", tasks: [] };
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tasks = db.prepare("SELECT id,title,status,created_at,updated_at FROM tasks ORDER BY updated_at DESC LIMIT 8").all();
    return {generatedAt:new Date().toISOString(),status:"observing",tasks:tasks.map(task=>{
      const events=db.prepare("SELECT id,run_id,event_type,payload_json,created_at FROM task_events WHERE task_id=? ORDER BY id").all(task.id);
      let context={}, gate;
      const calls=new Map();const tools=new Map();const usage={input:0,output:0,cacheRead:0,cacheWrite:0};const errors=[];
      for(const event of events){let payload;try{payload=JSON.parse(event.payload_json);}catch{continue;}
        if(event.event_type==="agent_run_context")context={engine:payload.engine,provider:payload.provider,model:payload.model,protocol:payload.protocol,build:payload.build};
        if(event.event_type==="agent_model_call" && payload.record)calls.set(payload.record.id,payload.record);
        if(event.event_type==="agent_tool_start")tools.set(`${event.run_id}:${payload.toolId}`,{name:payload.toolName,status:"running"});
        if(event.event_type==="agent_tool_result")tools.set(`${event.run_id}:${payload.toolId}`,{name:payload.toolName,status:payload.isError?"failed":"succeeded"});
        if(event.event_type==="agent_usage"){usage.input+=payload.inputTokens||0;usage.output+=payload.outputTokens||0;usage.cacheRead+=payload.cacheReadTokens||0;usage.cacheWrite+=payload.cacheWriteTokens||0;}
        if(["completion_verification","completion_gate"].includes(event.event_type))gate={status:payload.status,summary:payload.summary};
        if(event.event_type==="agent_error" || event.event_type.includes("failed"))errors.push({id:event.id,type:event.event_type});
      }
      const purposes={};const costs={};let unknown=0;
      for(const call of calls.values()){
        purposes[call.purpose]=(purposes[call.purpose]||0)+1;
        if(call.status!=="reported" || call.usage?.estimatedCost==null)unknown++;
        else costs[call.usage.costCurrency]=(costs[call.usage.costCurrency]||0)+call.usage.estimatedCost;
      }
      return {id:task.id,title:redact(task.title),status:task.status,createdAt:task.created_at,updatedAt:task.updated_at,lastEventId:events.at(-1)?.id??0,lastEventAt:events.at(-1)?.created_at,context,usage,modelCallsByPurpose:purposes,knownCostByCurrency:costs,unknownCostCalls:unknown,toolCalls:tools.size,toolFailures:[...tools.values()].filter(tool=>tool.status==="failed").length,gate,errors:errors.slice(-10)};
    })};
  }finally{db.close();}
}
fs.mkdirSync(path.dirname(output),{recursive:true});
do {
  try {const value=snapshot();fs.writeFileSync(output,JSON.stringify(value,null,2));if(!watch)console.log(JSON.stringify(value,null,2));}
  catch(error){if(!watch)throw error;fs.writeFileSync(output,JSON.stringify({generatedAt:new Date().toISOString(),status:"read_failed",message:redact(error.message)}));}
  if(watch)await new Promise(resolve=>setTimeout(resolve,20000));
} while(watch);
