// ReAct agent preset (SPEC §13): wires the stdlib components and systems into
// a spawnable AgentDef. Underneath it is plain ECS — auto-tag scoping (R34),
// dirty-triggered LLM↔tools cycle, approval interrupts, optional retry.

import {
  type AgentDef,
  type ComponentInit,
  defineAgent,
  type Model,
  type ResourceRef,
} from '@langecs/core';
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
  /**
   * The `Model` resource: a typed ref from `defineResource<Model>(...)` or the
   * plain resource name (e.g. `'model:main'`). Either way only the name is
   * stored (in the `ModelRef` component) — components hold data, not clients.
   */
  model: string | ResourceRef<Model>;
  /**
   * Tool names or ToolDefs. Only names land in the `Tools` component; ToolDef
   * implementations must still be registered on the world via
   * `registerTools(world, tools)` (components hold data, resources hold behavior).
   * Unlike `model`, tools stay string-named (no `ResourceRef`): the names double
   * as data in the `Tools` component and as what the model sees in tool specs.
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
  const modelName = typeof opts.model === 'string' ? opts.model : opts.model.resourceName;
  const components: ComponentInit<any>[] = [Messages([]), ModelRef(modelName), Tools(toolNames)];
  if (opts.systemPrompt !== undefined) components.push(SystemPrompt(opts.systemPrompt));
  if (opts.retry !== undefined) components.push(RetryPolicy(opts.retry));
  return defineAgent({
    name: opts.name,
    components,
    // retry only matches once a RetryPolicy is present; harmless otherwise.
    systems: [callLLM, toolApproval, executeTools, retry],
  });
}
