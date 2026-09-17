// The playground protocol, driven through a real MCP client over an in-memory
// transport — the same calls an outside agent makes. Zero network; the only
// model is a scriptedModel for the one authoring scenario.

import {
  Cancelled,
  type ModelRequest,
  type Msg,
  type ScriptedTurn,
  scriptedModel,
} from '@langecs/core';
import { PromptRuns, Recipe } from '@langecs/stdlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { createPlaygroundServer, type PlaygroundServer } from './server';
import {
  Assignment,
  buildRecipe,
  Closed,
  createPlaygroundWorld,
  Label,
  MODEL_RESOURCE,
  SYSTEM_NOTES,
  spawnConflictTicket,
  Ticket,
} from './world';

type Json = Record<string, unknown>;

interface Harness {
  client: Client;
  playground: PlaygroundServer;
  call: (name: string, args?: Json) => Promise<Json>;
  fail: (name: string, args?: Json) => Promise<string>;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.client.close();
    await h.playground.close();
  }
});

let worldCounter = 0;

async function harness(opts?: {
  allowAuthoring?: boolean;
  model?: ScriptedTurn[];
}): Promise<Harness> {
  worldCounter += 1;
  const model = scriptedModel(opts?.model ?? []);
  const { world, adapter } = createPlaygroundWorld({ model, id: `pg-${worldCounter}` });
  await world.run(); // the seed run: T-100 closes, T-101 goes quiet, T-102 parks
  const playground = createPlaygroundServer(
    { world, adapter },
    {
      build: (w) => buildRecipe(w, model),
      notes: SYSTEM_NOTES,
      ...(opts?.allowAuthoring !== undefined ? { allowAuthoring: opts.allowAuthoring } : {}),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playground.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  type ToolResult = {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: unknown;
  };
  const invoke = async (name: string, args: Json): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (result: ToolResult): string =>
    result.content.find((c) => c.type === 'text')?.text ?? '';
  const call = async (name: string, args: Json = {}): Promise<Json> => {
    const result = await invoke(name, args);
    if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
    return result.structuredContent as Json;
  };
  const fail = async (name: string, args: Json = {}): Promise<string> => {
    const result = await invoke(name, args);
    expect(result.isError).toBe(true);
    return textOf(result);
  };
  const h = { client, playground, call, fail };
  open.push(h);
  return h;
}

test('the seed leaves one closed, one quiet, one pending ticket — and the summary says so', async () => {
  const { call, playground } = await harness();
  const world = playground.active().world;
  const [clean, quiet, parked] = world.query(Ticket);
  expect(clean?.has(Closed)).toBe(true);
  expect(clean?.get(Label)).toBe('rush');
  expect(quiet?.has(Assignment)).toBe(false);
  expect(parked?.has(Assignment)).toBe(false);

  const summary = await call('inspect', { view: 'summary' });
  expect(summary.running).toBe(false);
  expect(summary.entityCount).toBe(3);
  expect(summary.interrupts).toEqual([
    { entity: parked?.id, interrupts: [expect.objectContaining({ kind: 'escalation' })] },
  ]);
  expect(summary.pendingPairs).toEqual([]); // quiescent: nothing left to fire
  expect(summary.narration).toEqual([
    `#${clean?.id} aims to refund the duplicate charge; is closed`,
    `#${quiet?.id} aims to answer the export question; is triaged`,
    `#${parked?.id} aims to restore service; is awaiting approval — WAITING for a human (escalation)`,
  ]);
  const tools = await playground.server.isConnected();
  expect(tools).toBe(true);
});

test('scenario 1 — explain names the missing positive term; one scoped edit repairs it', async () => {
  const { call, fail, playground } = await harness();
  const quiet = playground.active().world.query(Ticket)[1]!;

  const why = await call('explain', { entity: quiet.id, system: 'assignLow' });
  expect(why.match).toEqual({ matches: false, missing: ['pg.Sla'], blocking: [] });
  expect(
    (why.verdict as string).startsWith('Does not match. Missing positive term(s): pg.Sla.'),
  ).toBe(true);
  expect((why.system as Json).note).toBe(SYSTEM_NOTES.assignLow);

  // A stale revision is refused; the current one is accepted.
  const summary = await call('inspect', { view: 'summary' });
  const revision = summary.revision as number;
  expect(
    await fail('edit', {
      revision: revision - 1,
      op: 'set',
      entity: quiet.id,
      component: 'pg.Sla',
      value: { hours: 72 },
    }),
  ).toMatch(/Stale revision/);
  const edited = await call('edit', {
    revision,
    op: 'set',
    entity: quiet.id,
    component: 'pg.Sla',
    value: { hours: 72 },
  });
  expect(edited.revision).toBe(revision + 1);

  const explained = await call('explain', { entity: quiet.id, system: 'assignLow' });
  expect((explained.scheduling as Json).pendingReason).toBe('new-match');

  const run = await call('run', {});
  expect(run.operationStatus).toBe('finished');
  // Status is WORLD-wide (R28): the repaired ticket closed, but T-102 is still
  // parked on its interrupt, so the run reports 'pending', not 'done'.
  expect((run.result as Json).status).toBe('pending');
  expect(quiet.has(Closed)).toBe(true);
  expect(quiet.get(Assignment)).toEqual({ agent: 'front-desk' });
});

test('scenario 2 — the guard veto is visible evidence, and resume is the trusted way out', async () => {
  const { call, fail, playground } = await harness();
  const parked = playground.active().world.query(Ticket)[2]!;

  const why = await call('explain', { entity: parked.id, system: 'assignLow' });
  expect((why.match as Json).matches).toBe(true);
  expect((why.history as Json).lastVetoed).toEqual({ step: 2 });
  expect(why.verdict).toContain('its guard vetoed at step 2');
  expect(why.verdict).toContain('Guards are not evaluated here');

  // A stale revision is refused whatever the target; the operator answers through resume.
  expect(
    await fail('edit', {
      revision: 999,
      op: 'set',
      entity: parked.id,
      component: 'HumanResponse',
      value: { value: true },
    }),
  ).toMatch(/Stale revision/);
  const resumed = await call('resume', { entity: parked.id, value: { approved: true } });
  expect(resumed.operationStatus).toBe('finished');
  expect((resumed.result as Json).status).toBe('done');
  expect(parked.get(Assignment)).toEqual({ agent: 'senior-oncall-engineer' });
  expect(parked.has(Closed)).toBe(true);
  expect(resumed.narration).toContain(`#${parked.id} aims to restore service; is closed`);
});

test('scenario 3 — a barrier rejection is reported, commits nothing, and a data repair clears it', async () => {
  const { call, playground } = await harness();
  const world = playground.active().world;
  const before = world.snapshot();
  const conflict = spawnConflictTicket(world);
  const revisionAfterSpawn = playground.active().revision;

  const run = await call('run', {});
  expect(run.operationStatus).toBe('rejected');
  expect((run.error as Json).name).toBe('WriteConflictError');
  expect((run.error as Json).message).toMatch(/labelVip.*labelRush|labelRush.*labelVip/);
  // Nothing committed: same step, the ticket untouched, dirt intact (R30).
  expect(world.step).toBe(before.step);
  expect(world.entity(conflict.id)?.components()).not.toContain('pg.Triage');
  expect(world.snapshot().pendingPairs.length).toBeGreaterThan(0);

  const revision = playground.active().revision;
  expect(revision).toBe(revisionAfterSpawn + 1); // run:reject moved the host revision
  await call('edit', { revision, op: 'remove', entity: conflict.id, component: 'pg.Rush' });
  const again = await call('run', {});
  expect(again.operationStatus).toBe('finished');
  expect(world.entity(conflict.id)?.get(Label)).toBe('vip');
  expect(world.entity(conflict.id)?.has(Closed)).toBe(true);
});

test('run reports running past its response wait, run_status polls the same id, edits are refused meanwhile', async () => {
  const { call, fail, playground } = await harness();
  const world = playground.active().world;
  // A system that takes a while: registered on the live world (idle), global.
  const { defineSystem, defineTag, delay } = await import('@langecs/core');
  const Slow = defineTag(`pg.Slow-${worldCounter}`);
  world.use(
    defineSystem({
      name: `slow-${worldCounter}`,
      query: [Slow],
      run: async (e, ctx) => {
        await delay(150, ctx.signal);
        e.remove(Slow);
      },
    }),
  );
  world.spawn(Slow());

  const started = await call('run', { waitMs: 10 });
  expect(started.operationStatus).toBe('running');
  expect(started.runningPairs).toEqual([
    expect.objectContaining({ system: `slow-${worldCounter}` }),
  ]);
  expect(
    await fail('edit', {
      revision: started.revision as number,
      op: 'spawn',
      components: [{ component: 'pg.Vip' }],
    }),
  ).toMatch(/a run is in flight/);
  expect(await fail('run', {})).toMatch(/already in flight/);

  const settled = await call('run_status', {
    runId: started.runId,
    waitMs: 2000,
    cursor: started.eventCursor,
  });
  expect(settled.operationStatus).toBe('finished');
  expect(settled.runId).toBe(started.runId);
  expect((settled.result as Json).status).toBe('pending'); // T-102 is still parked (R28)
});

test('cancel is explicit: it stamps Cancelled and the run reports cancelled, not a fake limit', async () => {
  const { call, playground } = await harness();
  const world = playground.active().world;
  const { defineSystem, defineTag, delay } = await import('@langecs/core');
  const Hang = defineTag(`pg.Hang-${worldCounter}`);
  world.use(
    defineSystem({
      name: `hang-${worldCounter}`,
      query: [Hang],
      run: async (_e, ctx) => {
        await delay(10_000, ctx.signal); // only a cancel ends this
      },
    }),
  );
  world.spawn(Hang());
  const started = await call('run', { waitMs: 10 });
  expect(started.operationStatus).toBe('running');
  const cancelled = await call('cancel', { reason: 'operator stop' });
  expect(cancelled.ok).toBe(true);
  const settled = await call('run_status', { waitMs: 2000 });
  expect(settled.operationStatus).toBe('finished');
  expect((settled.result as Json).status).toBe('cancelled');
  expect(world.query(Cancelled).length).toBe(world.query().length);
});

test('checkpoint: history lists the seed steps and fork builds a fresh world from the recipe', async () => {
  const { call, playground } = await harness();
  const history = await call('checkpoint', { action: 'history' });
  const steps = (history.steps as { step: number }[]).map((h) => h.step);
  expect(steps.length).toBeGreaterThan(1);

  const forked = await call('checkpoint', { action: 'fork', step: steps[0]!, id: 'pg-fork' });
  expect(forked.active).toBe('pg-fork');
  expect(playground.sessions.has('pg-fork')).toBe(true);
  const fork = playground.sessions.get('pg-fork')!.world;
  expect(fork.step).toBe(steps[0]);
  expect(fork.systems().map((s) => s.key)).toEqual(
    playground.sessions
      .values()
      .next()
      .value!.world.systems()
      .map((s) => s.key),
  );
  // The fork is at the earlier boundary: the seed's outcomes are not yet there.
  expect(fork.query(Closed).length).toBeLessThan(
    playground.sessions.values().next().value!.world.query(Closed).length,
  );
  // Tools now address the fork by default; the original is untouched by running it.
  const run = await call('run', {});
  expect(run.world).toBe('pg-fork');
  const list = await call('checkpoint', { action: 'list' });
  expect((list.worlds as Json[]).map((w) => w.id)).toEqual([`pg-${worldCounter}`, 'pg-fork']);
});

test('install is off by default, and on: a declared prompt system runs through the recipe', async () => {
  const off = await harness();
  expect(await off.fail('install', { kind: 'component', decl: { name: 'x' } })).toMatch(
    /not found|Unknown tool|install/i,
  );

  const sentiment = (req: ModelRequest): Msg => ({
    role: 'assistant',
    content: /down|urgent/i.test(req.messages[0]?.content ?? '')
      ? '{"writes": {"pg.Sentiment": {"tone": "angry", "score": 0.9}}, "note": "outage language"}'
      : '{"writes": {"pg.Sentiment": {"tone": "neutral", "score": 0.2}}}',
  });
  const on = await harness({
    allowAuthoring: true,
    model: [sentiment, sentiment, sentiment, sentiment],
  });
  const world = on.playground.active().world;

  const component = await on.call('install', {
    kind: 'component',
    decl: {
      name: 'pg.Sentiment',
      description: 'how the customer sounds',
      schema: {
        type: 'object',
        properties: {
          tone: { type: 'string', enum: ['angry', 'neutral', 'happy'] },
          score: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['tone', 'score'],
        additionalProperties: false,
      },
    },
  });
  expect((component.recipe as Json).components).toHaveLength(1);

  // Reserved and unknown targets are refused at declaration time.
  expect(
    await on.fail('install', {
      kind: 'system',
      decl: {
        name: 'evil',
        query: ['pg.Ticket'],
        writes: ['HumanResponse'],
        model: MODEL_RESOURCE,
        prompt: 'x',
      },
    }),
  ).toMatch(/reserved/);
  expect(
    await on.fail('install', {
      kind: 'system',
      decl: { name: 'nomodel', query: ['pg.Ticket'], model: 'model:nope', prompt: 'x' },
    }),
  ).toMatch(/not registered/);

  const installed = await on.call('install', {
    kind: 'system',
    decl: {
      name: 'sentiment',
      description: 'reads the tone of a ticket',
      query: ['pg.Ticket'],
      not: ['pg.Sentiment'],
      writes: ['pg.Sentiment'],
      model: MODEL_RESOURCE,
      prompt: 'Judge the tone of the customer text.',
    },
  });
  expect(installed.systems).toContain('sentiment');
  // Registering a system newly matches every ticket: three pairs are dirty.
  const summary = await on.call('inspect', { view: 'summary' });
  expect((summary.pendingPairs as Json[]).filter((p) => p.system === 'sentiment')).toHaveLength(3);

  const run = await on.call('run', {});
  expect(run.operationStatus).toBe('finished');
  const Sentiment = (await import('@langecs/core')).getComponentByName('pg.Sentiment')!;
  const tones = world.query(Ticket).map((t) => (t.get(Sentiment) as { tone: string }).tone);
  expect(tones).toEqual(['neutral', 'neutral', 'angry']);
  for (const t of world.query(Ticket)) expect(t.get(PromptRuns)).toEqual({ sentiment: 1 });
  const ledger = await on.call('inspect', { view: 'ledger' });
  expect((ledger.attempts as Json[]).map((a) => a.proposal)).toEqual([
    'accepted',
    'accepted',
    'accepted',
  ]);

  // The declaration lives in the world: a fork carries it and keeps working.
  const history = await on.call('checkpoint', { action: 'history' });
  const last = (history.steps as { step: number }[]).at(-1)!.step;
  const forked = await on.call('checkpoint', {
    action: 'fork',
    step: last,
    id: 'pg-authored-fork',
  });
  const fork = on.playground.sessions.get(forked.active as string)!.world;
  expect(fork.query(Recipe)).toHaveLength(1);
  expect(fork.systems().map((s) => s.key)).toContain('sentiment');
});

test('the authoring boundary holds on every write path, not just install', async () => {
  const off = await harness();
  const summary = await off.call('inspect', { view: 'summary' });
  const revision = summary.revision as number;
  const recipe = {
    version: 1,
    components: [{ name: 'pg.Injected', schema: { type: 'string' } }],
    systems: [
      {
        name: 'injected',
        query: ['pg.Ticket'],
        writes: ['pg.Injected'],
        model: MODEL_RESOURCE,
        prompt: 'x',
      },
    ],
    order: [],
  };
  // Neither spawning nor setting Recipe is allowed through edit, nor through run input.
  expect(
    await off.fail('edit', {
      revision,
      op: 'spawn',
      components: [{ component: 'Recipe', value: recipe }],
    }),
  ).toMatch(/cannot be written through edit/);
  expect(
    await off.fail('edit', { revision, op: 'set', entity: 1, component: 'Recipe', value: recipe }),
  ).toMatch(/cannot be written through edit/);
  expect(
    await off.fail('run', { entity: 1, input: [{ component: 'Recipe', value: recipe }] }),
  ).toMatch(/cannot be written through edit/);
  expect(off.playground.active().world.query(Recipe)).toHaveLength(0);

  // A checkpoint that carries declarations is not compiled by a server without authoring.
  const on = await harness({ allowAuthoring: true });
  await on.call('install', {
    kind: 'component',
    decl: { name: 'pg.Carried', schema: { type: 'string' } },
  });
  const carried = on.playground.active().world.snapshot();
  // Hand the same snapshot to a no-authoring server by seeding its adapter.
  const offAgain = await harness();
  const s = offAgain.playground.active();
  s.adapter.save({ ...carried, worldId: s.id, step: 999 });
  expect(await offAgain.fail('checkpoint', { action: 'fork', step: 999 })).toMatch(
    /carries declared components/,
  );
});

test('edits to declared components are validated like proposals', async () => {
  const on = await harness({ allowAuthoring: true });
  await on.call('install', {
    kind: 'component',
    decl: { name: 'pg.Score', reducer: 'sum', schema: { type: 'number', maximum: 10 } },
  });
  const summary = await on.call('inspect', { view: 'summary' });
  let revision = summary.revision as number;
  expect(
    await on.fail('edit', { revision, op: 'set', entity: 1, component: 'pg.Score', value: 'nope' }),
  ).toMatch(/Invalid value for "pg.Score"/);
  await on.call('edit', { revision, op: 'set', entity: 1, component: 'pg.Score', value: 8 });
  revision += 1;
  // `add` is checked against the MERGED value.
  expect(
    await on.fail('edit', { revision, op: 'add', entity: 1, component: 'pg.Score', value: 5 }),
  ).toMatch(/13 exceeds maximum 10 \(after merging your write\)/);
  await on.call('edit', { revision, op: 'add', entity: 1, component: 'pg.Score', value: 2 });
  const Score = (await import('@langecs/core')).getComponentByName('pg.Score')!;
  expect(on.playground.active().world.entity(1)?.get(Score)).toBe(10);
});

test('run honours limit together with input, start events are recorded, and reads never bump the revision', async () => {
  const { call, playground } = await harness();
  const quiet = playground.active().world.query(Ticket)[1]!;
  const before = (await call('inspect', { view: 'summary' })).revision as number;
  await call('inspect', { view: 'ledger' });
  await call('inspect', { view: 'entity', entity: quiet.id });
  expect((await call('inspect', { view: 'summary' })).revision).toBe(before);

  // Adding Sla makes assignLow → draft → close a three-step tail; limit 1 stops after one.
  const run = await call('run', {
    entity: quiet.id,
    input: [{ component: 'pg.Sla', value: { hours: 72 } }],
    limit: 1,
  });
  expect(run.operationStatus).toBe('finished');
  expect((run.result as Json).status).toBe('limit');
  expect(quiet.has(Assignment)).toBe(true);
  expect(quiet.has(Closed)).toBe(false);
  const types = (run.events as { type: string }[]).map((e) => e.type);
  expect(types.slice(0, 3)).toEqual(['run:start', 'step:start', 'system:start']);
});

test('introspection is bounded everywhere a value can carry user data', async () => {
  worldCounter += 1;
  const model = scriptedModel([]);
  const { world, adapter } = createPlaygroundWorld({ model, id: `pg-${worldCounter}` });
  const { Goal } = await import('@langecs/stdlib');
  world.entity(1)?.set(Goal, 'x'.repeat(10_000));
  const playground = createPlaygroundServer(
    { world, adapter },
    { build: (w) => buildRecipe(w, model), notes: SYSTEM_NOTES, maxValueChars: 64 },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playground.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  open.push({ client, playground, call: async () => ({}), fail: async () => '' });
  const list = (await client.callTool({ name: 'inspect', arguments: { view: 'entities' } }))
    .structuredContent as Json;
  const first = (list.entities as Json[])[0]!;
  expect((first.goal as Json).$truncated).toBe(true);
  const summary = (await client.callTool({ name: 'inspect', arguments: { view: 'summary' } }))
    .structuredContent as Json;
  for (const line of summary.narration as string[]) expect(line.length).toBeLessThan(120);
});

test('the host policy decides which native components a prompt system may touch', async () => {
  const on = await harness({ allowAuthoring: true });
  // pg.Approved is the application's authorization marker: native, and not opened.
  expect(
    await on.fail('install', {
      kind: 'system',
      decl: {
        name: 'selfApprove',
        query: ['pg.Ticket'],
        writes: ['pg.Approved'],
        model: MODEL_RESOURCE,
        prompt: 'x',
      },
    }),
  ).toMatch(/native \(code-defined\) component/);
});

test('run ids are distinct across many runs, and the Recipe carrier cannot be removed or despawned', async () => {
  const on = await harness({ allowAuthoring: true });
  await on.call('install', {
    kind: 'component',
    decl: { name: 'pg.Keep', schema: { type: 'string' } },
  });
  const ids = new Set<string>();
  for (let i = 0; i < 30; i++) ids.add((await on.call('run', {})).runId as string);
  expect(ids.size).toBe(30);

  const world = on.playground.active().world;
  const carrier = world.query(Recipe)[0]!;
  const revision = (await on.call('inspect', { view: 'summary' })).revision as number;
  expect(
    await on.fail('edit', { revision, op: 'remove', entity: carrier.id, component: 'Recipe' }),
  ).toMatch(/cannot be removed through edit/);
  expect(await on.fail('edit', { revision, op: 'despawn', entity: carrier.id })).toMatch(
    /carries the world's Recipe/,
  );
  expect(world.query(Recipe)).toHaveLength(1);
});

test('error text in trace and explain is clipped like every other value', async () => {
  worldCounter += 1;
  const model = scriptedModel([]);
  const { world, adapter } = createPlaygroundWorld({ model, id: `pg-${worldCounter}` });
  const { defineSystem, defineTag } = await import('@langecs/core');
  const Boom = defineTag(`pg.Boom-${worldCounter}`);
  world.use(
    defineSystem({
      name: `boom-${worldCounter}`,
      query: [Boom],
      run: () => {
        throw new Error('x'.repeat(10_000));
      },
    }),
  );
  const e = world.spawn(Boom());
  const playground = createPlaygroundServer(
    { world, adapter },
    { build: (w) => buildRecipe(w, model), notes: SYSTEM_NOTES, maxValueChars: 64 },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playground.server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  open.push({ client, playground, call: async () => ({}), fail: async () => '' });
  const run = (await client.callTool({ name: 'run', arguments: {} })).structuredContent as Json;
  expect((run.traceTail as string).length).toBeLessThan(200);
  const trace = (await client.callTool({ name: 'inspect', arguments: { view: 'trace' } }))
    .structuredContent as Json;
  expect((trace.text as string).length).toBeLessThan(200);
  const why = (
    await client.callTool({
      name: 'explain',
      arguments: { entity: e.id, system: `boom-${worldCounter}` },
    })
  ).structuredContent as Json;
  const lastRan = (why.history as Json).lastRan as Json;
  expect(
    ((lastRan.error as Json).$truncated as boolean) === true ||
      JSON.stringify(lastRan.error).length < 200,
  ).toBe(true);
});
