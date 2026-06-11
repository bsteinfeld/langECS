// Deterministic choreography tests for the SQL agent: core scriptedModel only,
// zero network. The flight recorder (world trace) pins down the step-by-step
// flow; Messages pins down that every tool result lands as a `tool` message.

import { type ModelRequest, type Msg, type RunEvent, scriptedModel } from '@langecs/core';
import {
  lastAssistant,
  Messages,
  MessageWaiting,
  PendingToolCalls,
  sendMessage,
} from '@langecs/stdlib';
import { expect, test } from 'vitest';
import { createSqlAgentWorld } from './agent';
import { createMusicDb, createSqlTools } from './db';

const BEST_ARTIST_QUERY =
  'SELECT ar.name AS artist, COUNT(t.id) AS track_count ' +
  'FROM artists ar JOIN albums al ON al.artist_id = ar.id ' +
  'JOIN tracks t ON t.album_id = al.id ' +
  'GROUP BY ar.id ORDER BY track_count DESC LIMIT 1';

test('English -> SQL -> answer: step-by-step choreography (tables, schema, SELECT, answer)', async () => {
  const requests: ModelRequest[] = [];
  const turn =
    (message: Msg) =>
    (req: ModelRequest): Msg => {
      requests.push(req);
      return message;
    };
  // Scripted to follow the workflow the real model is prompted into:
  // list_tables -> get_schema -> run_query -> final answer.
  const model = scriptedModel([
    turn({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'list_tables', args: {} }],
    }),
    turn({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-2', name: 'get_schema', args: { tables: 'artists, albums, tracks' } },
      ],
    }),
    turn({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-3', name: 'run_query', args: { query: BEST_ARTIST_QUERY } }],
    }),
    turn({ role: 'assistant', content: 'Radiohead has the most tracks: 7.' }),
  ]);

  const { world, agent } = createSqlAgentWorld(model);
  const run = sendMessage(world, agent, 'Which artist has the most tracks?');
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run;

  expect(result.status).toBe('done');
  expect(result.steps).toBe(7);

  // Flow choreography from the flight recorder: callLLM and executeTools
  // alternate purely on dirty-triggering (no edges anywhere).
  const trace = world.getTrace();
  expect(trace.map((step) => step.runs.map((r) => r.system))).toEqual([
    ['sql-agent:callLLM'], //       1. user message + MessageWaiting dirt
    ['sql-agent:executeTools'], //  2. PendingToolCalls newly matches -> list_tables
    ['sql-agent:callLLM'], //       3. foreign Messages append re-fires the LLM
    ['sql-agent:executeTools'], //  4. get_schema
    ['sql-agent:callLLM'], //       5.
    ['sql-agent:executeTools'], //  6. run_query
    ['sql-agent:callLLM'], //       7. no tool calls -> removes MessageWaiting -> quiescent
  ]);
  // toolApproval shares executeTools' dirt but vetoes (no tool needs approval).
  for (const i of [1, 3, 5]) {
    expect(trace[i]?.vetoed).toEqual([{ system: 'sql-agent:toolApproval', entity: agent.id }]);
  }

  // Every tool result landed as a `tool` message, in order.
  const messages: Msg[] = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool', // list_tables result
    'assistant',
    'tool', // get_schema result
    'assistant',
    'tool', // run_query result
    'assistant',
  ]);
  expect(messages[2]).toMatchObject({
    role: 'tool',
    toolCallId: 'call-1',
    name: 'list_tables',
    content: 'albums, artists, tracks',
  });
  expect(messages[4]).toMatchObject({ role: 'tool', toolCallId: 'call-2', name: 'get_schema' });
  expect(messages[4]?.content).toContain('CREATE TABLE artists');
  expect(messages[4]?.content).toContain('CREATE TABLE tracks');
  expect(messages[4]?.content).toContain('sample rows');
  expect(messages[6]).toMatchObject({ role: 'tool', toolCallId: 'call-3', name: 'run_query' });
  expect(JSON.parse(messages[6]?.content ?? '')).toEqual([{ artist: 'Radiohead', track_count: 7 }]);

  // What the model saw: history grows by one tool exchange per call, and the
  // tool specs + system prompt ride along on every request.
  expect(requests).toHaveLength(4);
  expect(requests.map((r) => r.messages.length)).toEqual([1, 3, 5, 7]);
  expect(requests[3]?.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'tool',
    'assistant',
    'tool',
  ]);
  expect(requests[0]?.tools?.map((t) => t.name)).toEqual([
    'list_tables',
    'get_schema',
    'run_query',
  ]);
  expect(requests[0]?.system).toContain('SQLite');

  // Final answer streamed as token events (the demo's live output) and the
  // trigger components are consumed: the world is at rest.
  const tokens = events
    .filter((e): e is Extract<RunEvent, { type: 'custom' }> => e.type === 'custom')
    .map((e) => (e.data as { text: string }).text);
  expect(tokens.join('')).toBe('Radiohead has the most tracks: 7.');
  expect(lastAssistant(world, agent)?.content).toBe('Radiohead has the most tracks: 7.');
  expect(agent.has(MessageWaiting)).toBe(false);
  expect(agent.has(PendingToolCalls)).toBe(false);
});

test('non-SELECT is rejected, surfaced as a tool error message, and the model recovers', async () => {
  const model = scriptedModel([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'run_query', args: { query: 'DELETE FROM tracks' } }],
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-2', name: 'run_query', args: { query: 'SELECT COUNT(*) AS n FROM tracks;' } },
      ],
    },
    { role: 'assistant', content: 'There are 16 tracks.' },
  ]);

  const { world, agent, db } = createSqlAgentWorld(model);
  const result = await sendMessage(world, agent, 'Delete everything, then count the tracks.');
  expect(result.status).toBe('done');
  expect(result.steps).toBe(5); // LLM, tools(error), LLM, tools, LLM

  const messages: Msg[] = agent.get(Messages) ?? [];
  expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1', name: 'run_query' });
  expect(messages[2]?.content).toBe(
    'Error: run_query is read-only: a single SELECT statement is required.',
  );
  expect(messages[2]?.meta).toEqual({ error: true });
  // The error round-trip is the same dirty cycle as a success.
  expect(world.getTrace().map((s) => s.runs.map((r) => r.system))).toEqual([
    ['sql-agent:callLLM'],
    ['sql-agent:executeTools'],
    ['sql-agent:callLLM'],
    ['sql-agent:executeTools'],
    ['sql-agent:callLLM'],
  ]);
  // Trailing semicolons are tolerated on the legitimate SELECT.
  expect(JSON.parse(messages[4]?.content ?? '')).toEqual([{ n: 16 }]);
  // And the database really was untouched.
  expect(db.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 16 });
});

test('tools behave standalone: schema lookup, unknown table, statement smuggling', async () => {
  const db = createMusicDb();
  const [listTables, getSchema, runQuery] = createSqlTools(db);

  expect(await listTables?.execute({})).toBe('albums, artists, tracks');

  const schema = (await getSchema?.execute({ tables: 'tracks' })) as string;
  expect(schema).toContain('CREATE TABLE tracks');
  expect(schema).toContain('duration_ms');
  expect(schema).toContain('Breathe'); // sample rows included
  await expect(async () => getSchema?.execute({ tables: 'users' })).rejects.toThrow(
    /unknown table "users"/,
  );

  for (const query of [
    'UPDATE tracks SET name = ?',
    'PRAGMA table_info(tracks)',
    'SELECT 1; DROP TABLE artists',
    'INSERT INTO artists (id, name) VALUES (9, "x")',
  ]) {
    await expect(async () => runQuery?.execute({ query })).rejects.toThrow(/read-only/);
  }
  expect(await runQuery?.execute({ query: 'SELECT name FROM artists ORDER BY id LIMIT 1;' })).toBe(
    JSON.stringify([{ name: 'Pink Floyd' }]),
  );
});
