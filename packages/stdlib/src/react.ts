// ReAct agent preset (SPEC §13): wires the stdlib components and systems into
// a spawnable AgentDef. Underneath it is plain ECS — auto-tag scoping (R34),
// dirty-triggered LLM↔tools cycle, approval interrupts, optional retry.

import { type AgentDef, type ComponentInit, defineAgent } from '@langecs/core';
import {
  Messages,
  ModelRef,
  RetryPolicy,
  type RetryPolicyValue,
  SystemPrompt,
  Tools,
} from './components';
import { callLLM, executeTools, retry, toolApproval } from './systems';
import type { ToolDef } from './tools';

export interface ReactAgentOptions {
  /** Agent name; becomes the auto-tag `agent:<name>` (globally unique). */
  name: string;
  /** Resource name the `Model` is registered under (e.g. `'model:main'`). */
  model: string;
  /**
   * Tool names or ToolDefs. Only names land in the `Tools` component; ToolDef
   * implementations must still be registered on the world via
   * `registerTools(world, tools)` (components hold data, resources hold behavior).
   */
  tools?: (string | ToolDef)[];
  systemPrompt?: string;
  /** Adds a `RetryPolicy` so the bundled `retry` system heals failing systems. */
  retry?: RetryPolicyValue;
}

/**
 * A ReAct chat agent: `sendMessage(world, agent, text)` drives
 * LLM → tools → LLM → final answer, with human approval gates for tools
 * defined with `needsApproval` and optional SystemError retry.
 */
export function reactAgent(opts: ReactAgentOptions): AgentDef {
  const toolNames = (opts.tools ?? []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
  const components: ComponentInit<any>[] = [Messages([]), ModelRef(opts.model), Tools(toolNames)];
  if (opts.systemPrompt !== undefined) components.push(SystemPrompt(opts.systemPrompt));
  if (opts.retry !== undefined) components.push(RetryPolicy(opts.retry));
  return defineAgent({
    name: opts.name,
    components,
    // retry only matches once a RetryPolicy is present; harmless otherwise.
    systems: [callLLM, toolApproval, executeTools, retry],
  });
}
