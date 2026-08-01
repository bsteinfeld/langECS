// @langecs/stdlib — standard components, systems, helpers, and the ReAct
// preset for LangECS chat agents (SPEC §13).

export {
  BudgetExceeded,
  type BudgetStatus,
  BudgetWarning,
  type BudgetWatchdogOptions,
  budgetWatchdog,
  type Spend,
  spendOf,
  spentTokens,
  TokenBudget,
  TokenUsage,
} from './budget';
export {
  Inbox,
  type InboxItem,
  Messages,
  MessageWaiting,
  ModelRef,
  PendingToolCalls,
  RetryPolicy,
  type RetryPolicyValue,
  SystemPrompt,
  TokenEvent,
  type ToolCall,
  Tools,
} from './components';
export {
  estimateTokens,
  recentMessages,
  type WindowOptions,
  withMessageWindow,
} from './context';
export {
  type ExtractJsonOptions,
  extractJson,
  type RouteDecision,
  type RouteJsonOptions,
  type RouteSpec,
  routeJson,
  type Validator,
} from './extract';
export { ask, lastAssistant, sendMessage, userMessage } from './helpers';
// Narration (R64): `Phase`/`Goal` have NO scheduling role — they exist so a human
// (or a UI, or devtools) can read what the world is doing. Narration is state.
export { Goal, type Narration, narrate, narrateWorld, Phase } from './narration';
export { type ReactAgentOptions, reactAgent } from './react';
export { callLLM, executeTools, retry, toolApproval } from './systems';
export {
  bareToolName,
  defineTool,
  lookupTool,
  registerTools,
  type ToolDef,
  toolResourceName,
  toToolSpec,
} from './tools';
