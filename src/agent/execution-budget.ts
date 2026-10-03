import type { AllyCodeSettings } from "../config/schema.js";

/** Stage limits reset on continuation; durable accounting and memory do not. */
export function executionAllowance(budget: AllyCodeSettings["executionBudget"], priorTurns: number, priorTools: number) {
  const remainingTaskTurns = budget.enforceTaskLimits
    ? Math.max(0, budget.maxModelTurnsPerTask - priorTurns) : null;
  const remainingTaskTools = budget.enforceTaskLimits
    ? Math.max(0, budget.maxToolCallsPerTask - priorTools) : null;
  return {
    remainingTaskTurns,
    maxIterations: Math.min(budget.maxModelTurnsPerRun, remainingTaskTurns ?? Infinity),
    maxToolCalls: Math.min(budget.maxToolCallsPerRun, remainingTaskTools ?? Infinity),
  };
}
