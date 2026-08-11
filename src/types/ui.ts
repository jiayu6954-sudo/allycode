/**
 * UI state types shared across app, hooks, and components.
 */

export type AppState =
  | "idle"
  | "waiting_model"
  | "waiting_model_after_tool"
  | "streaming"
  | "tool_running"
  | "completed"
  | "permission_prompt"
  | "error"
  | "compacting";
