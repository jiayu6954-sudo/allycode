import {it, expect} from "vitest";
import {SettingsSchema} from "../../src/config/schema.js";
import {executionAllowance} from "../../src/agent/execution-budget.js";

it("migrates legacy 160/300 settings to resumable stages without resetting accounting",()=>{
  const budget=SettingsSchema.parse({executionBudget:{maxModelTurnsPerRun:80,maxModelTurnsPerTask:160,maxToolCallsPerTask:300}}).executionBudget;
  for(const consumed of [0,160,500,10000]) expect(executionAllowance(budget,consumed,consumed*2)).toEqual({remainingTaskTurns:null,maxIterations:80,maxToolCalls:300});
  expect(budget.maxModelTurnsPerTask).toBe(160);
});
it("honors explicitly enabled totals and finite stage limits",()=>{
  const budget=SettingsSchema.parse({executionBudget:{enforceTaskLimits:true,maxToolCallsPerRun:50}}).executionBudget;
  expect(executionAllowance(budget,150,280)).toEqual({remainingTaskTurns:10,maxIterations:10,maxToolCalls:20});
  expect(executionAllowance(budget,160,300)).toEqual({remainingTaskTurns:0,maxIterations:0,maxToolCalls:0});
});
