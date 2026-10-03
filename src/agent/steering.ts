export interface SteeringMessage { id: string; text: string; createdAt: string; }

/** Per-run inbox; the desktop journal is the durable source on resume. */
export class SteeringQueue {
  private items: SteeringMessage[] = [];
  enqueue(message: SteeringMessage): void {
    if (!message.text.trim() || message.text.length > 20000) throw new Error("补充内容需为 1–20000 个字符。");
    if (this.items.some(item => item.id === message.id)) return;
    if (this.items.length >= 20) throw new Error("待处理补充已达 20 条，请等待当前步骤结束。");
    if (!this.items.some(item => item.id === message.id)) this.items.push({...message,text:message.text.trim()});
  }
  peek(): SteeringMessage[] { return this.items.map(item=>({...item})); }
  acknowledge(ids: string[]): void { const applied=new Set(ids);this.items=this.items.filter(item=>!applied.has(item.id)); }
}

export function recoverSteering(events: Array<{eventType:string;payload:unknown}>): SteeringMessage[] {
  const pending=new Map<string,SteeringMessage>();
  for(const event of events){
    if (!event.payload || typeof event.payload !== "object") continue;
    const payload=event.payload as Partial<SteeringMessage>;
    if(event.eventType==="task_steering_queued" && typeof payload.id==="string" && typeof payload.text==="string" && typeof payload.createdAt==="string") pending.set(payload.id,payload as SteeringMessage);
    if(event.eventType==="task_steering_applied" && typeof payload.id==="string")pending.delete(payload.id);
  }
  return [...pending.values()];
}
