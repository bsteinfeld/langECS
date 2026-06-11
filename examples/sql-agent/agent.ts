// The SQL agent, shared by main.ts (real model) and sql-agent.test.ts
// (scriptedModel). The agent itself is ~10 lines: a ReAct preset with a SQL
// system prompt and three tool names. Behavior (model, db-bound tools) is
// registered per world as named resources; the AgentDef stays pure data.

import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentDef,
  createWorld,
  type EntityHandle,
  type Model,
  type World,
} from '@langecs/core';
import { reactAgent, registerTools } from '@langecs/stdlib';
import { createMusicDb, createSqlTools } from './db';

/** Resource name the model registers under (the ModelRef component points here). */
export const MODEL_RESOURCE = 'model:sql';

export const SQL_SYSTEM_PROMPT = `You are an agent designed to interact with a SQLite database.
Given an input question, create a syntactically correct SQLite query, run it,
then answer the question from the query results.

Follow this workflow, one tool call at a time:
1. Call list_tables to see which tables exist.
2. Call get_schema for EVERY table you might need, including bridge tables
   you will join through.
3. Call run_query with a single SELECT statement, then answer from the result.
   Join tables only along the foreign keys (REFERENCES ...) shown in the schema;
   never invent join columns.

Unless the user asks for a specific number of examples, limit queries to at
most 5 results, and never SELECT * — only the columns relevant to the question.
The database is read-only; DML statements (INSERT, UPDATE, DELETE, DROP, ...)
are rejected. If run_query returns an error, rewrite the query and try again.`;

/**
 * Defined once at module level: defineAgent registers the `agent:sql-agent`
 * tag in the global component registry (R7), so the def must be a singleton.
 * Any number of worlds can spawn it.
 */
export const sqlAgent: AgentDef = reactAgent({
  name: 'sql-agent',
  model: MODEL_RESOURCE,
  tools: ['list_tables', 'get_schema', 'run_query'],
  systemPrompt: SQL_SYSTEM_PROMPT,
});

export interface SqlAgentWorld {
  world: World;
  agent: EntityHandle;
  db: DatabaseSync;
}

/** Fresh world + seeded db, with the model and db-bound tools registered. */
export function createSqlAgentWorld(model: Model): SqlAgentWorld {
  const db = createMusicDb();
  const world = createWorld();
  world.register(MODEL_RESOURCE, model);
  registerTools(world, createSqlTools(db));
  const agent = world.spawn(sqlAgent);
  return { world, agent, db };
}
