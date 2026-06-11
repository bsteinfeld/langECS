// Shared agent definition for the human-in-the-loop example.
//
// Component definitions (including the agent's auto-tag `agent:records-bot`)
// are registered in a process-global registry exactly once (R7), so the
// AgentDef lives here and is reused by every world in the process:
// `world.spawn(recordsAgent)` on a fresh world, `world.use(recordsAgent)` on a
// world that is about to `load()` a snapshot.

import type { AgentDef } from '@langecs/core';
import { defineTool, reactAgent, type ToolDef } from '@langecs/stdlib';

/** World resource name the chat model is registered under. */
export const MODEL_RESOURCE = 'model:records';

/** World id => snapshot directory name under the persistence root. */
export const WORLD_ID = 'records-world';

export const SYSTEM_PROMPT =
  'You are a meticulous records administrator. Use lookup_record to inspect ' +
  'records and delete_record to delete them. Deletions are destructive — ' +
  'call delete_record only when the user explicitly asks for a deletion.';

/**
 * Tool implementations are behavior, so they live in world resources — never
 * in components, never in snapshots. A resumed process simply re-creates them
 * and registers them on the new world (`registerTools`). `onDelete` lets the
 * demo print and the test count real executions.
 */
export function recordTools(onDelete?: (id: number) => void): ToolDef[] {
  const lookupRecord = defineTool({
    name: 'lookup_record',
    description: 'Look up a record by numeric id. Read-only.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The record id.' } },
      required: ['id'],
    },
    execute: (args) => {
      const { id } = args as { id: number };
      return JSON.stringify({ id, owner: 'acme-corp', status: 'active', sizeKb: 184 });
    },
  });

  const deleteRecord = defineTool({
    name: 'delete_record',
    description: 'Permanently delete a record by numeric id. This cannot be undone.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The record id to delete.' } },
      required: ['id'],
    },
    // The entire approval policy. The stdlib `toolApproval` system turns this
    // into an AwaitingHuman interrupt before `executeTools` ever runs.
    needsApproval: true,
    execute: (args) => {
      const { id } = args as { id: number };
      onDelete?.(id);
      return `Record ${id} permanently deleted.`;
    },
  });

  return [lookupRecord, deleteRecord];
}

/** Names of the tools above, as they appear in the agent's `Tools` component. */
export const TOOL_NAMES = ['lookup_record', 'delete_record'];

/** The ReAct agent bundle: components + scoped systems, defined once per process. */
export const recordsAgent: AgentDef = reactAgent({
  name: 'records-bot',
  model: MODEL_RESOURCE,
  tools: TOOL_NAMES,
  systemPrompt: SYSTEM_PROMPT,
});
