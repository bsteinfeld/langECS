// The declarative layer: components and prompt systems as data. Zero network —
// every model turn is a scriptedModel turn function keyed on the system name
// the contract puts in `req.system`.

import {
  createWorld,
  defineSystem,
  getComponentByName,
  listComponents,
  type Model,
  type ModelRequest,
  type Msg,
  SystemError,
  scriptedModel,
  WriteConflictError,
} from '@langecs/core';
import { expect, test } from 'vitest';
import {
  BudgetExceeded,
  budgetWatchdog,
  componentFromDecl,
  declarationOf,
  declareComponent,
  declareSystem,
  forkFromSnapshot,
  hydrateRecipe,
  Messages,
  PromptRuns,
  ProposalRejected,
  promptLedger,
  Recipe,
  readRecipe,
  systemFromDecl,
  TokenBudget,
  TokenUsage,
  validateSystemDecl,
} from '../src/index';

const MODEL = 'model:decl';

/** A stateless `Model` answering every call with `answer(req)` — for multi-call tests. */
const modelOf = (answer: (req: ModelRequest) => Msg): Model => ({
  async generate(req) {
    return { message: answer(req) };
  },
});

/** Scripted turns answering by the system name embedded in the contract. */
const bySystem =
  (answers: Record<string, string | ((req: ModelRequest) => string)>) =>
  (req: ModelRequest): Msg => {
    const name = /You are the system "([^"]+)"/.exec(req.system ?? '')?.[1] ?? '';
    const answer = answers[name];
    if (answer === undefined) throw new Error(`no scripted answer for system ${name}`);
    return { role: 'assistant', content: typeof answer === 'string' ? answer : answer(req) };
  };

// ----------------------------------------------------------- component decls

test('componentFromDecl: named reducers behave like their R59 counterparts', async () => {
  const Log = componentFromDecl({ name: 'dt.Log', reducer: 'append', max: 3 });
  const Total = componentFromDecl({ name: 'dt.Total', reducer: 'sum' });
  const Meta = componentFromDecl({ name: 'dt.Meta', reducer: 'merge' });
  const Latest = componentFromDecl({ name: 'dt.Latest', reducer: 'last-wins' });
  const Plain = componentFromDecl({ name: 'dt.Plain' });
  const Kick = componentFromDecl({ name: 'dt.Kick', tag: true });

  const writer = (name: string, run: (e: any) => void) =>
    defineSystem({ name, query: [Kick], run: (e) => run(e) });
  const world = createWorld();
  world.use(
    writer('dt.w1', (e) => {
      e.add(Log, ['a', 'b']);
      e.add(Total, 2);
      e.add(Meta, { x: 1 });
      e.add(Latest, 'first');
    }),
  );
  world.use(
    writer('dt.w2', (e) => {
      e.add(Log, ['c', 'd']);
      e.add(Total, 3);
      e.add(Meta, { y: 2 });
      e.add(Latest, 'second');
    }),
  );
  const e = world.spawn(Kick(), Log([]), Total(0), Meta({}));
  await world.run();
  expect(e.get(Log)).toEqual(['b', 'c', 'd']); // append, capped at 3 (keep last)
  expect(e.get(Total)).toBe(5);
  expect(e.get(Meta)).toEqual({ x: 1, y: 2 });
  expect(e.get(Latest)).toBe('second'); // deterministic: later registration wins

  // A plain declared component keeps R30: two writers is a conflict, not a merge.
  const w = createWorld();
  w.use(writer('dt.p1', (x) => x.set(Plain, 1)));
  w.use(writer('dt.p2', (x) => x.set(Plain, 2)));
  w.spawn(Kick());
  await expect(w.run()).rejects.toBeInstanceOf(WriteConflictError);
});

test('componentFromDecl: idempotent for an identical declaration, strict otherwise', () => {
  const first = componentFromDecl({
    name: 'dt.Score',
    schema: { type: 'number' },
    description: 'v1',
  });
  const again = componentFromDecl({
    name: 'dt.Score',
    schema: { type: 'number' },
    description: 'v2 wording',
  });
  expect(again).toBe(first);
  expect(declarationOf('dt.Score')?.description).toBe('v2 wording');

  expect(() => componentFromDecl({ name: 'dt.Score', schema: { type: 'string' } })).toThrow(
    /different schema, reducer or tag-ness/,
  );
  expect(() => componentFromDecl({ name: 'dt.Score', reducer: 'sum' })).toThrow(/different/);
  expect(() => componentFromDecl({ name: 'Messages' })).toThrow(/already defined in code/);
  expect(() => componentFromDecl({ name: 'Cancelled' })).toThrow(/reserved/);
  expect(() => componentFromDecl({ name: 'dt.T', tag: true, reducer: 'sum' })).toThrow(/tag/);
  expect(() => componentFromDecl({ name: 'dt.M', max: 3 })).toThrow(/only applies/);
  expect(() => componentFromDecl({ name: 'dt.R', reducer: 'weird' as unknown as 'sum' })).toThrow(
    /unknown reducer/,
  );
});

// ----------------------------------------------------------- system decls

test('validateSystemDecl: unknown names, reserved targets, empty query', () => {
  componentFromDecl({ name: 'dt.V' });
  expect(() =>
    validateSystemDecl({ name: 's', query: ['dt.Nope'], model: MODEL, prompt: 'p' }),
  ).toThrow(/unknown component "dt.Nope"/);
  expect(() => validateSystemDecl({ name: 's', query: [], model: MODEL, prompt: 'p' })).toThrow(
    /at least one component/,
  );
  for (const reserved of ['Cancelled', 'Recipe', 'PendingToolCalls', 'TokenUsage', 'Tools']) {
    expect(() =>
      validateSystemDecl({
        name: 's',
        query: ['dt.V'],
        writes: [reserved],
        model: MODEL,
        prompt: 'p',
      }),
    ).toThrow(/reserved/);
    expect(() =>
      validateSystemDecl({
        name: 's',
        query: ['dt.V'],
        removes: [reserved],
        model: MODEL,
        prompt: 'p',
      }),
    ).toThrow(/reserved/);
  }
  // Reads may name anything readable, including control state.
  expect(() =>
    validateSystemDecl({
      name: 's',
      query: ['dt.V'],
      reads: ['dt.V', 'SystemError'],
      model: MODEL,
      prompt: 'p',
    }),
  ).not.toThrow();
});

// ------------------------------------------------------------ the happy path

const Ticket = componentFromDecl({
  name: 'dt.Ticket',
  description: 'the customer request',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
});
const Triage = componentFromDecl({
  name: 'dt.Triage',
  description: 'the routing decision',
  schema: {
    type: 'object',
    properties: { priority: { type: 'string', enum: ['low', 'high'] } },
    required: ['priority'],
    additionalProperties: false,
  },
});
const Open = componentFromDecl({ name: 'dt.Open', tag: true });

const triageDecl = {
  name: 'dt.triage',
  description: 'routes tickets',
  query: ['dt.Ticket', 'dt.Open'],
  writes: ['dt.Triage'],
  removes: ['dt.Open'],
  model: MODEL,
  prompt: 'Read the ticket and set a priority.',
};

test('a prompt system applies a valid proposal through ordinary buffered writes', async () => {
  const requests: ModelRequest[] = [];
  const world = createWorld();
  world.register(
    MODEL,
    scriptedModel([
      bySystem({
        'dt.triage': (req) => {
          requests.push(req);
          return '{"writes": {"dt.Triage": {"priority": "high"}}, "remove": ["dt.Open"], "note": "outage"}';
        },
      }),
    ]),
  );
  const system = declareSystem(world, triageDecl);
  const ledger = promptLedger(world);
  const e = world.spawn(Ticket({ text: 'Site is down' }), Open());

  const events: unknown[] = [];
  const run = world.run();
  for await (const event of run) if (event.type === 'custom') events.push(event.data);
  const result = await run;

  expect(result.status).toBe('done');
  expect(result.steps).toBe(1);
  expect(e.get(Triage)).toEqual({ priority: 'high' });
  expect(e.has(Open)).toBe(false);
  // Receipts and bookkeeping ride along with the proposal.
  expect(e.get(TokenUsage)).toHaveLength(1);
  expect(e.get(TokenUsage)?.[0]?.system).toBe('dt.triage');
  expect(e.get(PromptRuns)).toEqual({ 'dt.triage': 1 });
  expect(ledger.attempts).toEqual([
    expect.objectContaining({
      system: 'dt.triage',
      entity: e.id,
      step: 1,
      attempt: 1,
      status: 'delivered',
      proposal: 'accepted',
    }),
  ]);
  expect(ledger.spent()).toBeGreaterThan(0);
  expect(events).toEqual([
    {
      kind: 'proposal-applied',
      system: 'dt.triage',
      entity: e.id,
      writes: ['dt.Triage'],
      remove: ['dt.Open'],
      note: 'outage',
    },
  ]);

  // The request: static contract in `system`, the entity's reads as JSON in the
  // user turn, the pair's signal forwarded (R51).
  const req = requests[0];
  expect(req?.system).toContain('You are the system "dt.triage"');
  expect(req?.system).toContain('routes tickets');
  expect(req?.system).toContain('- dt.Triage — the routing decision (schema');
  expect(req?.system).toContain('You MAY remove these components: dt.Open.');
  expect(req?.messages[0]?.content).toContain(`Entity #${e.id}`);
  expect(req?.messages[0]?.content).toContain('"dt.Ticket"');
  expect(req?.messages[0]?.content).not.toContain('agent:');
  expect(req?.signal).toBeDefined();

  // The recipe recorded the system and the registration order.
  expect(readRecipe(world).systems).toEqual([triageDecl]);
  expect(readRecipe(world).order).toEqual(world.systems().map((s) => s.key));
  expect(world.systems().map((s) => s.key)).toContain(system.name);
  // The effective query carries the standard guards.
  const info = world.systems().find((s) => s.key === 'dt.triage');
  expect(info?.query.exclude).toEqual(['Cancelled', 'BudgetExceeded', 'ProposalRejected']);
  expect(info?.hasGuard).toBe(true);
});

test('a rejected proposal is state, not an error: retry once, then park, then resume on clear', async () => {
  const requests: ModelRequest[] = [];
  let turn = 0;
  const world = createWorld();
  world.register(
    MODEL,
    modelOf(
      bySystem({
        'dt.triage': (req) => {
          requests.push(req);
          turn += 1;
          if (turn === 1) return '{"writes": {"dt.Triage": {"priority": "urgent"}}}'; // enum
          if (turn === 2) return '{"writes": {"dt.Other": 1}, "remove": ["dt.Ticket"]}'; // not allowed
          return '{"writes": {"dt.Triage": {"priority": "low"}}, "remove": ["dt.Open"]}';
        },
      }),
    ),
  );
  declareSystem(world, triageDecl);
  const ledger = promptLedger(world);
  const e = world.spawn(Ticket({ text: 'Typo on the pricing page' }), Open());

  const result = await world.run();
  expect(result.status).toBe('done'); // not 'error': nothing threw
  expect(result.errors).toEqual([]);
  expect(e.has(Triage)).toBe(false);
  expect(e.has(Open)).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages.at(-1)?.content).toContain('Your reply was rejected');
  expect(requests[1]?.messages.at(-1)?.content).toContain('must be one of "low", "high"');

  const rejected = e.get(ProposalRejected) ?? [];
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ system: 'dt.triage', step: 1 });
  expect(rejected[0]?.errors.join('\n')).toContain(
    '"dt.Other" is not in this system\'s allowed writes',
  );
  expect(rejected[0]?.errors.join('\n')).toContain(
    '"dt.Ticket" is not in this system\'s allowed removes',
  );
  // Both paid calls are receipted, in the mirror and in the ledger.
  expect(e.get(TokenUsage)).toHaveLength(2);
  expect(ledger.attempts.map((a) => [a.attempt, a.status, a.proposal])).toEqual([
    [1, 'delivered', 'rejected'],
    [2, 'delivered', 'rejected'],
  ]);
  expect(e.get(PromptRuns)).toEqual({ 'dt.triage': 1 });

  // Parked: Not(ProposalRejected) unmatched the system, so a foreign change to
  // the ticket does not spend another call...
  e.set(Ticket, { text: 'Typo on the pricing page (edited)' });
  expect((await world.run()).status).toBe('idle');
  expect(requests).toHaveLength(2);

  // ...and clearing the record is the explicit "try again": a new match fires it.
  e.remove(ProposalRejected);
  const again = await world.run();
  expect(again.status).toBe('done');
  expect(requests).toHaveLength(3);
  expect(e.get(Triage)).toEqual({ priority: 'low' });
  expect(e.has(Open)).toBe(false);
});

test('validation covers the MERGED value for reducer components, and the fragment kind', async () => {
  const Notes = componentFromDecl({
    name: 'dt.Notes',
    reducer: 'append',
    schema: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  });
  const Count = componentFromDecl({
    name: 'dt.Count',
    reducer: 'sum',
    schema: { type: 'number', maximum: 10 },
  });
  const Poke = componentFromDecl({ name: 'dt.Poke', tag: true });
  let turn = 0;
  const requests: ModelRequest[] = [];
  const world = createWorld();
  world.register(
    MODEL,
    modelOf(
      bySystem({
        'dt.noter': (req) => {
          requests.push(req);
          turn += 1;
          // 1: would exceed maxItems after merging; 2: wrong fragment kind; 3: sum past maximum
          if (turn === 1) return '{"writes": {"dt.Notes": ["c"]}}';
          if (turn === 2) return '{"writes": {"dt.Notes": "c"}}';
          if (turn === 3) return '{"writes": {"dt.Count": 5}}';
          return '{"writes": {"dt.Count": "x"}}';
        },
      }),
    ),
  );
  declareSystem(world, {
    name: 'dt.noter',
    query: ['dt.Poke'],
    writes: ['dt.Notes', 'dt.Count'],
    model: MODEL,
    prompt: 'Add a note.',
    haltOnRejection: false,
  });
  const e = world.spawn(Poke(), Notes(['a', 'b']), Count(8));
  await world.run();
  const [first] = e.get(ProposalRejected) ?? [];
  // The record carries the FINAL attempt's violations (turn 2: wrong kind); the
  // first attempt's merged-value violation went back to the model as context.
  expect(first?.errors).toEqual(['dt.Notes: reducer "append" takes an array fragment, got "c"']);
  expect(e.get(Notes)).toEqual(['a', 'b']);
  // ...and the run continued to the next step? No: the rejection is a self-write
  // and Poke did not change, so the world is quiescent. Poke again to see the
  // sum checks (turns 3 and 4).
  e.remove(Poke);
  e.add(Poke);
  await world.run();
  // Turn 3's merged-sum violation went back to the model as retry context; the
  // record keeps the final attempt's violation (turn 4: wrong kind).
  expect(requests[3]?.messages.at(-1)?.content).toContain(
    'dt.Count: 13 exceeds maximum 10 (after merging your write)',
  );
  const [, second] = e.get(ProposalRejected) ?? [];
  expect(second?.errors).toEqual(['dt.Count: reducer "sum" takes a number, got "x"']);
  expect(e.get(Count)).toBe(8);
  expect(turn).toBe(4);
});

test('a provider failure throws (R31 path): SystemError, no receipts, ledger row failed', async () => {
  const world = createWorld();
  world.register(
    MODEL,
    scriptedModel([
      () => {
        throw new Error('503 from the provider');
      },
    ]),
  );
  declareSystem(world, triageDecl);
  const ledger = promptLedger(world);
  const e = world.spawn(Ticket({ text: 'x' }), Open());
  const result = await world.run();
  expect(result.status).toBe('error');
  expect(e.get(SystemError)?.[0]?.error.message).toBe('503 from the provider');
  expect(e.has(TokenUsage)).toBe(false); // the buffer was discarded (R31)...
  expect(ledger.attempts).toEqual([
    expect.objectContaining({ status: 'failed', error: '503 from the provider' }),
  ]); // ...but the host-owned ledger kept the attempt, with no token count (unknown, not zero)
  expect(ledger.attempts[0]?.tokens).toBeUndefined();
});

test('maxRuns brakes two data-defined systems that keep waking each other', async () => {
  const Ping = componentFromDecl({
    name: 'dt.Ping',
    reducer: 'last-wins',
    schema: { type: 'number' },
  });
  const Pong = componentFromDecl({
    name: 'dt.Pong',
    reducer: 'last-wins',
    schema: { type: 'number' },
  });
  const world = createWorld({ recursionLimit: 100 });
  const shown = (req: ModelRequest): Record<string, number> =>
    JSON.parse(req.messages[0]?.content.split('\n').slice(1).join('\n') ?? '{}');
  world.register(
    MODEL,
    modelOf(
      bySystem({
        'dt.pinger': (req) => `{"writes": {"dt.Pong": ${(shown(req)['dt.Ping'] ?? 0) + 1}}}`,
        'dt.ponger': (req) => `{"writes": {"dt.Ping": ${(shown(req)['dt.Pong'] ?? 0) + 1}}}`,
      }),
    ),
  );
  declareSystem(world, {
    name: 'dt.pinger',
    query: ['dt.Ping'],
    writes: ['dt.Pong'],
    model: MODEL,
    prompt: 'p',
    maxRuns: 2,
  });
  declareSystem(world, {
    name: 'dt.ponger',
    query: ['dt.Pong'],
    writes: ['dt.Ping'],
    model: MODEL,
    prompt: 'p',
    maxRuns: 2,
  });
  const e = world.spawn(Ping(0), Pong(0));
  const result = await world.run();
  // Without the brake this is an explicit cycle bounded only by recursionLimit.
  expect(result.status).toBe('done');
  expect(e.get(PromptRuns)).toEqual({ 'dt.pinger': 2, 'dt.ponger': 2 });
  expect(result.steps).toBeLessThan(8);
  // The last wake was vetoed by the guard, visibly.
  expect(world.getTrace().some((s) => s.vetoed.length > 0)).toBe(true);
});

test('declareSystem refuses two prompt systems that would collide on a plain component', () => {
  const Out = componentFromDecl({ name: 'dt.Out' });
  componentFromDecl({ name: 'dt.OutMerged', reducer: 'append' });
  const In = componentFromDecl({ name: 'dt.In', tag: true });
  void Out;
  void In;
  const world = createWorld();
  declareSystem(world, {
    name: 'dt.a',
    query: ['dt.In'],
    writes: ['dt.Out', 'dt.OutMerged'],
    model: MODEL,
    prompt: 'p',
  });
  expect(() =>
    declareSystem(world, {
      name: 'dt.b',
      query: ['dt.In'],
      writes: ['dt.Out'],
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/WriteConflictError at the barrier \(R30\)/);
  expect(() =>
    declareSystem(world, {
      name: 'dt.c',
      query: ['dt.In'],
      removes: ['dt.OutMerged'],
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/write against a remove/);
  // Concurrent adds on a reducer component are the legitimate fan-in.
  expect(() =>
    declareSystem(world, {
      name: 'dt.d',
      query: ['dt.In'],
      writes: ['dt.OutMerged'],
      model: MODEL,
      prompt: 'p',
    }),
  ).not.toThrow();
  // The same declaration twice is idempotent; a changed prompt under the same name is not.
  expect(() =>
    declareSystem(world, {
      name: 'dt.d',
      query: ['dt.In'],
      writes: ['dt.OutMerged'],
      model: MODEL,
      prompt: 'p',
    }),
  ).not.toThrow();
  expect(() =>
    declareSystem(world, {
      name: 'dt.d',
      query: ['dt.In'],
      writes: ['dt.OutMerged'],
      model: MODEL,
      prompt: 'changed',
    }),
  ).toThrow(/already registered with a different definition/);
});

test('a budget brakes a prompt system like any other spender (R63)', async () => {
  const world = createWorld();
  world.register(
    MODEL,
    scriptedModel([
      bySystem({ 'dt.triage2': '{"writes": {"dt.Triage": {"priority": "low"}}}' }),
      // Nothing else scripted: a second call would throw.
    ]),
  );
  world.use(budgetWatchdog());
  // No `not: ['BudgetExceeded']` here: the compiler adds the brake itself.
  declareSystem(world, { ...triageDecl, name: 'dt.triage2', removes: [] });
  const e = world.spawn(Ticket({ text: 'first' }), Open(), TokenBudget(1));
  expect((await world.run()).status).toBe('done');
  expect(e.get(Triage)).toEqual({ priority: 'low' });
  expect(e.has(BudgetExceeded)).toBe(true); // the receipt tipped the 1-token budget
  // Foreign dirt on the query no longer reaches the system: it is unmatched.
  e.set(Ticket, { text: 'second' });
  expect((await world.run()).status).toBe('idle');
});

// ------------------------------------------------------------------ recipe

const handWritten = defineSystem({
  name: 'dt.stamp',
  query: [Ticket],
  run: (e) => {
    if (!e.has(Messages)) e.add(Messages, [{ role: 'system', content: 'seen' }]);
  },
});

test('the world carries its vocabulary: forkFromSnapshot rehydrates declarations and continues', async () => {
  const Verdict = { name: 'dt.Verdict', schema: { type: 'string', enum: ['ok', 'escalate'] } };
  const build = (w: ReturnType<typeof createWorld>) => {
    w.use(handWritten);
    w.register(
      MODEL,
      scriptedModel([bySystem({ 'dt.judge': '{"writes": {"dt.Verdict": "ok"}}' })]),
    );
  };
  const original = createWorld({ id: 'recipe-demo' });
  build(original);
  declareComponent(original, Verdict);
  declareSystem(original, {
    name: 'dt.judge',
    query: ['dt.Ticket'],
    not: ['dt.Verdict'],
    writes: ['dt.Verdict'],
    model: MODEL,
    prompt: 'Judge.',
  });
  const first = original.spawn(Ticket({ text: 'first' }));
  await original.run();
  expect(first.get(getComponentByName('dt.Verdict')!)).toBe('ok');
  const snapshot = original.snapshot();
  expect(snapshot.entities.some((e) => Recipe.componentName in e.components)).toBe(true);

  // A fresh world, built from the snapshot alone plus the app's hand-written recipe.
  const fork = forkFromSnapshot({ snapshot, build, id: 'recipe-fork' });
  expect(readRecipe(fork)).toEqual(readRecipe(original));
  expect(fork.systems().map((s) => s.key)).toEqual(original.systems().map((s) => s.key));
  const second = fork.spawn(Ticket({ text: 'second' }));
  const result = await fork.run();
  expect(result.status).toBe('done');
  expect(second.get(getComponentByName('dt.Verdict')!)).toBe('ok');
  // The original is untouched by the fork's timeline.
  expect(original.query(Ticket)).toHaveLength(1);
});

test('hydrateRecipe refuses a different registration order, and validates before registering', () => {
  const Flag = componentFromDecl({ name: 'dt.Flag', tag: true });
  void Flag;
  const other = defineSystem({ name: 'dt.other', query: [Ticket], run: () => {} });
  const original = createWorld();
  original.use(handWritten);
  original.use(other);
  declareSystem(original, {
    name: 'dt.flagger',
    query: ['dt.Ticket'],
    writes: ['dt.Flag'],
    model: MODEL,
    prompt: 'p',
  });
  const snapshot = original.snapshot();

  // Hand-written systems registered in the other order: barrier order differs.
  const swapped = createWorld();
  swapped.use(other);
  swapped.use(handWritten);
  expect(() => hydrateRecipe(swapped, snapshot)).toThrow(/registration order differs/);
  expect(() => hydrateRecipe(swapped, snapshot, { strict: false })).not.toThrow();

  // A recipe with a broken declaration registers nothing.
  const broken = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const carrier = broken.entities.find((e) => Recipe.componentName in e.components)!;
  const recipe = carrier.components[Recipe.componentName] as {
    components: unknown[];
    systems: unknown[];
  };
  recipe.components.push({ name: 'dt.NeverDeclared' });
  recipe.systems.push({ name: 'dt.bad', query: ['dt.DoesNotExist'], model: MODEL, prompt: 'p' });
  const fresh = createWorld();
  fresh.use(handWritten);
  fresh.use(other);
  expect(() => hydrateRecipe(fresh, broken)).toThrow(/unknown component "dt.DoesNotExist"/);
  expect(getComponentByName('dt.NeverDeclared')).toBeUndefined();
  expect(fresh.systems().map((s) => s.key)).toEqual(['dt.stamp', 'dt.other']);
});

test('systemFromDecl is memoized on the canonical declaration', () => {
  const a = systemFromDecl({ name: 'dt.memo', query: ['dt.Ticket'], model: MODEL, prompt: 'p' });
  const b = systemFromDecl({ prompt: 'p', model: MODEL, query: ['dt.Ticket'], name: 'dt.memo' });
  expect(a).toBe(b);
});

// ------------------------------------------------- review-round findings

test('a declared tag is a real tag: zero-arg spawn, reported as a tag, survives a snapshot', () => {
  const Flag = componentFromDecl({ name: 'dt.Flag2', tag: true });
  const world = createWorld();
  const e = world.spawn(Flag());
  expect(e.get(Flag)).toBe(true);
  expect(listComponents().find((c) => c.name === 'dt.Flag2')?.tag).toBe(true);
  const restored = createWorld();
  restored.load(world.snapshot());
  expect(restored.entity(e.id)?.has(Flag)).toBe(true);
});

test('the declared schema holds under CONCURRENT merges: a violating merged value rejects the step', async () => {
  const Sum = componentFromDecl({
    name: 'dt.Sum',
    reducer: 'sum',
    schema: { type: 'number', maximum: 10 },
  });
  const Go = componentFromDecl({ name: 'dt.Go', tag: true });
  const bump = (name: string) => defineSystem({ name, query: [Go], run: (e) => e.add(Sum, 6) });
  const world = createWorld();
  world.use(bump('dt.bumpA'));
  world.use(bump('dt.bumpB'));
  const e = world.spawn(Go(), Sum(0));
  // Each write alone is fine (0 + 6 <= 10); together they are not. The reducer
  // is the only code that sees the merged value, so it refuses at staging.
  await expect(world.run()).rejects.toThrow(
    /dt.Sum.*merged value violates its schema.*12 exceeds maximum 10/,
  );
  expect(e.get(Sum)).toBe(0); // nothing committed (R25/R30)
  // A single writer commits normally.
  const single = createWorld();
  single.use(bump('dt.bumpC'));
  const f = single.spawn(Go(), Sum(0));
  await single.run();
  expect(f.get(Sum)).toBe(6);
});

test('maxRuns is enforced at admission from the host ledger, so a rolled-back step cannot be paid for again', async () => {
  const Plain = componentFromDecl({ name: 'dt.PlainOut' });
  const Poke2 = componentFromDecl({ name: 'dt.Poke2', tag: true });
  componentFromDecl({ name: 'dt.Out2', reducer: 'last-wins' });
  let calls = 0;
  const world = createWorld();
  world.register(
    MODEL,
    modelOf(
      bySystem({
        'dt.payer': () => {
          calls += 1;
          return '{"writes": {"dt.Out2": 1}}';
        },
      }),
    ),
  );
  // Two native siblings collide on a plain component every step: the barrier
  // rejects, so PromptRuns never commits and the pair stays dirty.
  world.use(defineSystem({ name: 'dt.clashA', query: [Poke2], run: (e) => e.set(Plain, 'a') }));
  world.use(defineSystem({ name: 'dt.clashB', query: [Poke2], run: (e) => e.set(Plain, 'b') }));
  declareSystem(world, {
    name: 'dt.payer',
    query: ['dt.Poke2'],
    writes: ['dt.Out2'],
    model: MODEL,
    prompt: 'p',
    maxRuns: 1,
  });
  const e = world.spawn(Poke2());
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  }
  expect(e.has(PromptRuns)).toBe(false); // never committed
  expect(calls).toBe(1); // admitted once; the ledger refused the other two
  const ledger = promptLedger(world);
  expect(ledger.attempts.filter((a) => a.system === 'dt.payer')).toHaveLength(1);
});

test('hydrateRecipe refuses conflicting duplicates INSIDE one manifest before registering anything', () => {
  const world = createWorld();
  const snapshot = world.snapshot();
  snapshot.entities.push({
    id: 99,
    components: {
      Recipe: {
        version: 1,
        components: [
          { name: 'dt.Dup', schema: { type: 'string' } },
          { name: 'dt.Dup', schema: { type: 'number' } },
        ],
        systems: [],
        order: [],
      },
    },
  });
  snapshot.nextEntityId = 100;
  expect(() => hydrateRecipe(world, snapshot)).toThrow(/declares component "dt.Dup" twice/);
  expect(getComponentByName('dt.Dup')).toBeUndefined();
});

test('a prompt system never calls the model on an entity already over budget', async () => {
  const world = createWorld();
  world.register(MODEL, scriptedModel([])); // any call would throw "exhausted"
  declareSystem(world, { ...triageDecl, name: 'dt.triage3', removes: [] });
  const e = world.spawn(Ticket({ text: 'x' }), Open(), BudgetExceeded({ spent: 5, budget: 1 }));
  expect((await world.run()).status).toBe('idle');
  expect(e.has(Triage)).toBe(false);
});

test('native components are not writable by prompt systems unless the host allows them', () => {
  componentFromDecl({ name: 'dt.Native.In', tag: true });
  const world = createWorld();
  // `Phase` is stdlib's, defined in code: being native is not authorization.
  expect(() =>
    declareSystem(world, {
      name: 'dt.nat',
      query: ['dt.Native.In'],
      writes: ['Phase'],
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/native \(code-defined\) component.*allowNative/);
  expect(() =>
    declareSystem(
      world,
      { name: 'dt.nat', query: ['dt.Native.In'], writes: ['Phase'], model: MODEL, prompt: 'p' },
      { allowNative: ['Phase'] },
    ),
  ).not.toThrow();
  // A declared component can still be denied by the host.
  componentFromDecl({ name: 'dt.Native.Out' });
  expect(() =>
    declareSystem(
      world,
      {
        name: 'dt.nat2',
        query: ['dt.Native.In'],
        writes: ['dt.Native.Out'],
        model: MODEL,
        prompt: 'p',
      },
      { deny: ['dt.Native.Out'] },
    ),
  ).toThrow(/denied by the host policy/);
  // And the stored manifest is held to the same policy when rehydrated.
  const snapshot = world.snapshot();
  const fresh = createWorld();
  expect(() => hydrateRecipe(fresh, snapshot)).toThrow(/native \(code-defined\) component/);
  expect(() =>
    hydrateRecipe(fresh, snapshot, { policy: { allowNative: ['Phase'] } }),
  ).not.toThrow();
});

test('re-declaring a system keeps its slot, and a component-only recipe still pins the native order', () => {
  const Kick3 = componentFromDecl({ name: 'dt.Kick3', tag: true });
  void Kick3;
  componentFromDecl({ name: 'dt.OutA', reducer: 'append' });
  componentFromDecl({ name: 'dt.OutB', reducer: 'append' });
  const native = defineSystem({ name: 'dt.native3', query: [Ticket], run: () => {} });
  const world = createWorld();
  world.use(native);
  const a = {
    name: 'dt.sysA',
    query: ['dt.Kick3'],
    writes: ['dt.OutA'],
    model: MODEL,
    prompt: 'p',
  };
  const b = {
    name: 'dt.sysB',
    query: ['dt.Kick3'],
    writes: ['dt.OutB'],
    model: MODEL,
    prompt: 'p',
  };
  declareSystem(world, a);
  declareSystem(world, b);
  declareSystem(world, a); // idempotent: must not move A behind B
  expect(readRecipe(world).systems.map((x) => x.name)).toEqual(['dt.sysA', 'dt.sysB']);
  expect(readRecipe(world).order).toEqual(['dt.native3', 'dt.sysA', 'dt.sysB']);
  const fork = forkFromSnapshot({ snapshot: world.snapshot(), build: (w) => w.use(native) });
  expect(fork.systems().map((x) => x.key)).toEqual(['dt.native3', 'dt.sysA', 'dt.sysB']);

  // Components only: the recipe still records the hand-written systems, and a
  // fork that forgets to build them is refused instead of hydrating an empty world.
  const world2 = createWorld();
  world2.use(native);
  declareComponent(world2, { name: 'dt.OnlyComp', schema: { type: 'string' } });
  expect(readRecipe(world2).order).toEqual(['dt.native3']);
  expect(() => forkFromSnapshot({ snapshot: world2.snapshot() })).toThrow(
    /registration order differs/,
  );
});

test('a malformed schema is refused at declaration, not after a paid model reply', () => {
  expect(() =>
    componentFromDecl({
      name: 'dt.BadSchema1',
      schema: null as unknown as Record<string, unknown>,
    }),
  ).toThrow(/malformed schema/);
  expect(() => componentFromDecl({ name: 'dt.BadSchema2', schema: { type: 5 } })).toThrow(
    /unknown type 5/,
  );
  expect(() =>
    componentFromDecl({
      name: 'dt.BadSchema3',
      schema: { type: 'object', properties: { a: 'string' } },
    }),
  ).toThrow(/properties\.a: a schema must be a JSON object/);
  expect(() =>
    componentFromDecl({ name: 'dt.BadSchema4', schema: { type: 'string', pattern: '(' } }),
  ).toThrow(/not a valid regular expression/);
  expect(() =>
    componentFromDecl({
      name: 'dt.GoodSchema',
      schema: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    }),
  ).not.toThrow();
});

test('the low-level factory refuses to run without a ledger, before any call is paid for', async () => {
  const Poke3 = componentFromDecl({ name: 'dt.Poke3', tag: true });
  const Out3 = componentFromDecl({ name: 'dt.Out3', reducer: 'last-wins' });
  let calls = 0;
  const world = createWorld();
  world.register(
    MODEL,
    modelOf(() => {
      calls += 1;
      return { role: 'assistant', content: '{"writes": {"dt.Out3": 1}}' };
    }),
  );
  world.use(
    systemFromDecl({
      name: 'dt.lowlevel',
      query: ['dt.Poke3'],
      writes: ['dt.Out3'],
      model: MODEL,
      prompt: 'p',
    }),
  );
  const e = world.spawn(Poke3());
  const result = await world.run();
  expect(result.status).toBe('error');
  expect(result.errors[0]?.records[0]?.error.message).toMatch(/needs the world's PromptLedger/);
  expect(calls).toBe(0);
  expect(e.has(Out3)).toBe(false);
  // With the ledger registered the same world works once the pair is re-armed
  // (the failed pair's dirt was consumed, R31); the failure record auto-clears (R32).
  promptLedger(world);
  e.remove(Poke3);
  e.add(Poke3);
  const again = await world.run();
  expect(again.status).toBe('done');
  expect(calls).toBe(1);
  expect(e.get(Out3)).toBe(1);
});

test('a manifest with a malformed system field is refused before any of its components register', () => {
  const Q = componentFromDecl({ name: 'dt.Q', tag: true });
  void Q;
  const world = createWorld();
  const snapshot = world.snapshot();
  snapshot.entities.push({
    id: 99,
    components: {
      Recipe: {
        version: 1,
        components: [{ name: 'dt.Poison', schema: { type: 'string' } }],
        systems: [
          { name: 'dt.malformed', query: ['dt.Q'], reads: 'dt.Q', model: MODEL, prompt: 'p' },
        ],
        order: ['dt.malformed'],
      },
    },
  });
  snapshot.nextEntityId = 100;
  expect(() => hydrateRecipe(world, snapshot)).toThrow(
    /"reads" must be an array of component names/,
  );
  expect(getComponentByName('dt.Poison')).toBeUndefined();
  expect(world.systems()).toEqual([]);
  // The same shape checks apply to a live declaration.
  expect(() =>
    declareSystem(world, {
      name: 'dt.badShape',
      query: ['dt.Q'],
      maxRuns: 0,
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/"maxRuns" must be a positive integer/);
  expect(() =>
    declareSystem(world, {
      name: 'dt.badShape2',
      query: ['dt.Q'],
      timeoutMs: -1,
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/"timeoutMs" must be a positive finite number/);
  expect(() =>
    declareSystem(world, {
      name: 'dt.badShape3',
      query: ['dt.Q'],
      haltOnRejection: 'yes' as unknown as boolean,
      model: MODEL,
      prompt: 'p',
    }),
  ).toThrow(/"haltOnRejection" must be a boolean/);
});
