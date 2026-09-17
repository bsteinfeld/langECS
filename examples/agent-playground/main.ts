// The agent playground: a LangECS world served over MCP (stdio) for an outside
// agent to operate.
//
//   node --import tsx examples/agent-playground/main.ts                     # MCP server on stdio
//   node --import tsx examples/agent-playground/main.ts --allow-authoring   # + the `install` tool
//   pnpm -C examples agent-playground -- --tour                             # scripted in-process tour, prints
//
// Point Claude Code (or any MCP client) at it with the config in ./mcp.json.
// The stdio transport owns stdout, so everything human-facing goes to stderr.
//
// With OPENAI_API_KEY in the repo-root .env.local, installed prompt systems use
// gpt-4o-mini; otherwise a policy model answers with an empty, valid proposal.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnvLocal } from '../_shared/env';
import { createPlaygroundServer } from './server';
import {
  buildRecipe,
  createPlaygroundWorld,
  policyModel,
  SYSTEM_NOTES,
  spawnConflictTicket,
} from './world';

loadEnvLocal();
const args = new Set(process.argv.slice(2));
const allowAuthoring = args.has('--allow-authoring');
const model =
  process.env.OPENAI_API_KEY === undefined ? policyModel() : fromAiSdk(openai('gpt-4o-mini'));

const { world, adapter } = createPlaygroundWorld({ model });
// Seed run: T-100 closes, T-101 goes quiet (no Sla), T-102 parks on approval.
await world.run();

const playground = createPlaygroundServer(
  { world, adapter },
  {
    build: (w) => buildRecipe(w, model),
    notes: SYSTEM_NOTES,
    allowAuthoring,
    // Narration is the only native state prompt systems may touch here; the
    // application's own markers (Approved, Closed, …) stay the recipe's.
    allowNativeWrites: ['Phase', 'Goal'],
  },
);

if (args.has('--tour')) {
  // An in-process client walks the three scenarios and prints every tool result —
  // the same calls an agent would make, minus the agent.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playground.server.connect(serverTransport);
  const client = new Client({ name: 'tour', version: '0.0.0' });
  await client.connect(clientTransport);

  const call = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const result = (await client.callTool({ name, arguments: params })) as {
      content: { type: string; text?: string }[];
      structuredContent?: unknown;
    };
    const text = result.content.find((c) => c.type === 'text');
    console.log(`\n▶ ${name} ${JSON.stringify(params)}\n${text?.text ?? ''}`);
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };

  const summary = await call('inspect', { view: 'summary' });
  let revision = summary.revision as number;

  console.log('\n=== Scenario 1: quiet but incomplete (T-101, entity 2) ===');
  await call('explain', { entity: 2, system: 'assignLow' });
  await call('edit', { revision, op: 'set', entity: 2, component: 'pg.Sla', value: { hours: 72 } });
  const r1 = await call('run', {});
  revision = r1.revision as number;

  console.log('\n=== Scenario 2: parked on a human (T-102, entity 3) ===');
  await call('explain', { entity: 3, system: 'assignLow' });
  const r2 = await call('resume', { entity: 3, value: { approved: true } });
  revision = r2.revision as number;

  console.log('\n=== Scenario 3: a conflict after work (T-103) ===');
  const conflict = spawnConflictTicket(world);
  revision = playground.active().revision;
  const r3 = await call('run', {});
  revision = r3.revision as number;
  await call('edit', { revision, op: 'remove', entity: conflict.id, component: 'pg.Rush' });
  await call('run', {});

  console.log('\n=== Checkpoints ===');
  const history = await call('checkpoint', { action: 'history' });
  const steps = (history.steps as { step: number }[]).map((h) => h.step);
  await call('checkpoint', { action: 'fork', step: steps[0] ?? 0, id: 'playground@start' });
  await call('inspect', { view: 'summary' });

  await client.close();
  await playground.close();
  process.exit(0);
}

console.error(
  `[agent-playground] MCP server on stdio — world "${world.id}" at step ${world.step}, ` +
    `${world.query().length} entities, authoring ${allowAuthoring ? 'ENABLED' : 'off (pass --allow-authoring)'}, ` +
    `model ${process.env.OPENAI_API_KEY === undefined ? 'policy (no key)' : 'gpt-4o-mini'}.`,
);
await playground.server.connect(new StdioServerTransport());
