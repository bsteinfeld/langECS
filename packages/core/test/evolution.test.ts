// Snapshot schema evolution (R54-R56), resume fencing (R57) and save cadence
// (R58) — the properties that decide whether "durable worlds" survives a deploy
// and a double-click, not just a process restart.

import { expect, test } from 'vitest';
import {
  createWorld,
  defineComponent,
  defineSystem,
  delay,
  MemoryAdapter,
  type Snapshot,
  scriptedModel,
} from '../src/index';

// A vocabulary that gets renamed between versions: `Draft` becomes `Article`,
// and the system that writes it is renamed too (the harder half — pendingPairs
// reference systems by key).
const Draft = defineComponent<{ text: string }>({ name: 'evo.Draft' });
const Article = defineComponent<{ text: string }>({ name: 'evo.Article' });
const Topic = defineComponent<string>({ name: 'evo.Topic' });

const writeArticle = defineSystem({
  name: 'writeArticle',
  query: [Topic],
  run: (e) => {
    e.set(Article, { text: `about ${e.get(Topic)}` });
  },
});

/** The v1 world: old component name, old system name. */
function v1World() {
  const world = createWorld({ id: 'evo', recipeVersion: 1 });
  world.use(
    defineSystem({
      name: 'writeDraft',
      query: [Topic],
      run: (e) => {
        e.set(Draft, { text: `about ${e.get(Topic)}` });
      },
    }),
  );
  return world;
}

/** The v2 world: new names, plus the migration that bridges them. */
function v2World() {
  const world = createWorld({ id: 'evo', recipeVersion: 2 });
  world.use(writeArticle);
  world.migration(1, 2, (s) => {
    for (const entity of s.entities) {
      if ('evo.Draft' in entity.components) {
        entity.components['evo.Article'] = entity.components['evo.Draft'];
        delete entity.components['evo.Draft'];
      }
    }
    for (const pair of s.pendingPairs) {
      if (pair.system === 'writeDraft') pair.system = 'writeArticle';
    }
    return s;
  });
  return world;
}

test('R54 recipeVersion is stamped, and is separate from the envelope format version', () => {
  const plain = createWorld();
  // A world that never opted in writes no recipeVersion at all, so snapshots
  // stay byte-identical to what earlier builds produced.
  expect(plain.snapshot().recipeVersion).toBeUndefined();
  expect(plain.snapshot().version).toBe(1);

  const versioned = createWorld({ recipeVersion: 7 });
  const snapshot = versioned.snapshot();
  // The engine's format version and the application's vocabulary version are
  // different numbers that move on different schedules.
  expect(snapshot.version).toBe(1);
  expect(snapshot.recipeVersion).toBe(7);
});

test('R54 a migration renames a component AND its pendingPairs system on load', async () => {
  const old = v1World();
  const topic = old.spawn(Topic('scheduling'));
  await old.run();
  expect(old.entity(topic.id)?.get(Draft)).toEqual({ text: 'about scheduling' });

  // Pause with dirt outstanding, the way a world awaiting a human would.
  old.entity(topic.id)?.set(Topic, 'scheduling v2');
  const paused = old.snapshot();
  expect(paused.pendingPairs.map((p) => p.system)).toEqual(['writeDraft']);

  // Deploy: new code, new names. Without a migration this snapshot is
  // permanently unloadable — the failure this whole feature exists to prevent.
  const next = v2World();
  const report = next.load(paused);

  expect(report.migrated).toEqual([{ from: 1, to: 2 }]);
  expect(next.entity(topic.id)?.get(Article)).toEqual({ text: 'about scheduling' });
  expect(next.entity(topic.id)?.has(Draft)).toBe(false);
  // The renamed pending pair resumes as the new system.
  expect(next.snapshot().pendingPairs.map((p) => p.system)).toEqual(['writeArticle']);
  await next.run();
  expect(next.entity(topic.id)?.get(Article)).toEqual({ text: 'about scheduling v2' });
  // And it is written back at the new version.
  expect(next.snapshot().recipeVersion).toBe(2);
});

test('R54 migrations chain transitively, in ascending order', () => {
  const seen: number[] = [];
  const world = createWorld({ recipeVersion: 4 });
  world.migration(1, 2, (s) => {
    seen.push(1);
    return s;
  });
  world.migration(2, 3, (s) => {
    seen.push(2);
    return s;
  });
  world.migration(3, 4, (s) => {
    seen.push(3);
    return s;
  });

  const report = world.load({ ...emptySnapshot(), recipeVersion: 1 });
  expect(seen).toEqual([1, 2, 3]);
  expect(report.migrated).toEqual([
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 4 },
  ]);
});

test('R54 a snapshot from NEWER code fails loudly instead of being misread', () => {
  const world = createWorld({ recipeVersion: 1 });
  // Migrations only run forward: only code that knows the later schema can read
  // it, so a rollback must refuse rather than silently misinterpret live state.
  expect(() => world.load({ ...emptySnapshot(), recipeVersion: 5 })).toThrow(
    /newer than this world's 1/,
  );
  try {
    world.load({ ...emptySnapshot(), recipeVersion: 5 });
  } catch (err) {
    expect((err as { name: string; fromFuture: boolean }).name).toBe('RecipeVersionError');
    expect((err as { fromFuture: boolean }).fromFuture).toBe(true);
  }
});

test('R54 a gap in the chain names the missing step', () => {
  const world = createWorld({ recipeVersion: 3 });
  world.migration(2, 3, (s) => s);
  expect(() => world.load({ ...emptySnapshot(), recipeVersion: 1 })).toThrow(
    /No migration path from snapshot recipeVersion 1 to this world's 3/,
  );
});

test('R54 two migrations from one version are rejected at registration', () => {
  const world = createWorld({ recipeVersion: 3 });
  world.migration(1, 2, (s) => s);
  // An ambiguous chain would make the upgrade path depend on registration order.
  expect(() => world.migration(1, 3, (s) => s)).toThrow(/single forward chain/);
  // Re-registering the identical edge is idempotent, so module reloads are fine.
  expect(() => world.migration(1, 2, (s) => s)).not.toThrow();
});

test('R56 canLoad answers at deploy time, without mutating anything', async () => {
  const old = v1World();
  const topic = old.spawn(Topic('scheduling'));
  await old.run();
  const paused = old.snapshot();

  // A world with no migration registered: this is what CI should catch.
  const broken = createWorld({ id: 'evo', recipeVersion: 2 });
  broken.use(writeArticle);
  const check = broken.canLoad(paused);
  expect(check.ok).toBe(false);
  if (!check.ok) expect(check.missingMigration).toEqual({ from: 1, to: 2 });
  // Purely a question — no entities, no step, nothing touched.
  expect(broken.query().length).toBe(0);
  expect(broken.step).toBe(0);

  // With the migration in place it is loadable, and canLoad says so because it
  // checks the MIGRATED snapshot rather than the raw one.
  expect(v2World().canLoad(paused)).toEqual({ ok: true });

  // Names that no build resolves are reported individually, which is what turns
  // this into a deploy-gate check rather than a yes/no.
  const foreign: Snapshot = {
    ...paused,
    recipeVersion: 2,
    entities: [{ id: topic.id, components: { 'gone.Component': 1 } }],
    pendingPairs: [{ entity: topic.id, system: 'goneSystem', reason: 'new-match' }],
  };
  const bare = createWorld({ id: 'evo', recipeVersion: 2 });
  const bareCheck = bare.canLoad(foreign);
  expect(bareCheck.ok).toBe(false);
  if (!bareCheck.ok) {
    expect(bareCheck.components).toEqual(['gone.Component']);
    expect(bareCheck.systems).toEqual(['goneSystem']);
  }
});

test('R55 strict:false preserves an unknown component instead of destroying it', async () => {
  const world = createWorld({ id: 'rolling' });
  world.use(writeArticle);
  const entity = world.spawn(Topic('rolling deploy'));
  await world.run();

  // A snapshot containing a component this build does not know — exactly what a
  // rolling deploy produces when the other version owns it.
  const snapshot = world.snapshot();
  const target = snapshot.entities.find((e) => e.id === entity.id);
  if (target) target.components['other.OwnedByNewerCode'] = { keep: 'me' };

  const strict = createWorld({ id: 'rolling' });
  strict.use(writeArticle);
  expect(() => strict.load(snapshot)).toThrow(/Unknown component/);

  const lenient = createWorld({ id: 'rolling' });
  lenient.use(writeArticle);
  const report = lenient.load(snapshot, { strict: false });
  expect(report.preserved).toEqual([{ entity: entity.id, component: 'other.OwnedByNewerCode' }]);
  // Inert: it joins no query and is not readable as a component…
  expect(lenient.query().length).toBe(1);
  // …but it round-trips, so the deploy that does not understand it cannot
  // silently delete the other version's state.
  const round = lenient.snapshot();
  expect(round.entities.find((e) => e.id === entity.id)?.components).toMatchObject({
    'other.OwnedByNewerCode': { keep: 'me' },
    'evo.Article': { text: 'about rolling deploy' },
  });
});

test('R55 strict:false reports dropped pendingPairs, because dirt cannot be preserved', async () => {
  const old = v1World();
  old.spawn(Topic('scheduling'));
  const paused = old.snapshot(); // dirt for 'writeDraft', which the next world lacks

  const next = createWorld({ id: 'evo', recipeVersion: 1 });
  next.use(writeArticle);
  const report = next.load(paused, { strict: false });

  // A component value can be kept as opaque data; dirt names a system that has
  // to be SCHEDULED, so there is nowhere to keep it. Hence: reported loudly.
  expect(report.droppedPairs).toEqual([{ entity: 1, system: 'writeDraft', reason: 'new-match' }]);
  expect(next.snapshot().pendingPairs).toEqual([]);
});

test('R57 expectedStep catches a resume that lost a race, with no adapter involved', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'fenced', persistence: adapter });
  world.use(writeArticle);
  world.spawn(Topic('a'));
  await world.run();

  const snapshot = (await adapter.load('fenced')) as Snapshot;
  const fresh = createWorld({ id: 'fenced' });
  fresh.use(writeArticle);

  expect(() => fresh.load(snapshot, { expectedStep: snapshot.step + 1 })).toThrow(
    /Snapshot is at step 1, but step 2 was expected/,
  );
  expect(fresh.load(snapshot, { expectedStep: snapshot.step }).migrated).toEqual([]);
});

test('R57 two workers resume one snapshot and exactly one advances', async () => {
  const adapter = new MemoryAdapter();
  const seed = createWorld({ id: 'race', persistence: adapter, fence: true });
  seed.use(writeArticle);
  seed.spawn(Topic('seed'));
  await seed.run();
  const shared = (await adapter.load('race')) as Snapshot;

  // The recommended deployment shape, raced: a double-click, two tabs, or a
  // queue retry after a timeout produces exactly this.
  const build = () => {
    const w = createWorld({ id: 'race', persistence: adapter, fence: true });
    w.use(writeArticle);
    w.load(shared);
    // New work for each worker, so both genuinely want to advance the world.
    w.query(Topic)[0]?.set(Topic, 'contended');
    return w;
  };
  const workerA = build();
  const workerB = build();

  const [a, b] = await Promise.allSettled([workerA.run(), workerB.run()]);

  // One wins outright; the loser is fenced out rather than silently writing a
  // divergent history nobody will read.
  const outcomes = [a.status, b.status].sort();
  expect(outcomes).toEqual(['fulfilled', 'rejected']);
  const loser = a.status === 'rejected' ? a : (b as PromiseRejectedResult);
  expect((loser.reason as Error).name).toBe('FenceError');
  expect((loser.reason as Error).message).toMatch(/lost the race and has stopped/);

  // The persisted history has exactly one step 2 — no interleaved timeline.
  const history = adapter.history('race');
  expect(history.filter((h) => h.step === 2)).toHaveLength(1);
});

test('R57 claim() fences BEFORE any step runs, so side effects stay exactly-once', async () => {
  const adapter = new MemoryAdapter();
  const ran: string[] = [];
  const sideEffect = defineSystem({
    name: 'sideEffect',
    query: [Topic],
    run: (e) => {
      ran.push(e.get(Topic));
      e.set(Article, { text: 'done' });
    },
  });
  const seed = createWorld({ id: 'claim', persistence: adapter });
  seed.use(sideEffect);
  seed.spawn(Topic('seed'));
  await seed.run();
  const shared = (await adapter.load('claim')) as Snapshot;

  const worker = () => {
    const w = createWorld({ id: 'claim', persistence: adapter, fence: true });
    w.use(sideEffect);
    w.load(shared);
    w.query(Topic)[0]?.set(Topic, 'contended');
    return w;
  };
  const a = worker();
  const b = worker();
  ran.length = 0;

  const attempt = async (w: ReturnType<typeof worker>) => {
    // The ordering that matters: claim, THEN run.
    await w.claim();
    return w.run();
  };
  const results = await Promise.allSettled([attempt(a), attempt(b)]);

  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  // Fencing only at save time would let the loser's systems run first — a
  // duplicate refund, a second delete — and refuse merely the write. Claiming up
  // front is what prevents the work itself.
  expect(ran).toEqual(['contended']);
});

test('R57 claim() refuses a worker resuming a STALE snapshot, even if it claims first', async () => {
  const adapter = new MemoryAdapter();
  const seed = createWorld({ id: 'stale', persistence: adapter });
  seed.use(writeArticle);
  seed.spawn(Topic('one'));
  await seed.run();
  const older = (await adapter.load('stale')) as Snapshot; // step 1

  // Someone advances the world while our worker still holds the older snapshot.
  const ahead = createWorld({ id: 'stale', persistence: adapter });
  ahead.use(writeArticle);
  ahead.load(older);
  ahead.query(Topic)[0]?.set(Topic, 'two');
  await ahead.run();
  expect(ahead.step).toBeGreaterThan(older.step);

  // The stale worker claims FIRST in fence terms — its step is lower, so a
  // monotonic fence has nothing to refuse it with. Without the staleness check it
  // would be granted, run its side effects, and only be refused at its first save.
  const stale = createWorld({ id: 'stale', persistence: adapter, fence: true });
  stale.use(writeArticle);
  stale.load(older);
  await expect(stale.claim()).rejects.toThrow(/Snapshot is at step 1, but step 2 was expected/);

  // A worker holding the CURRENT snapshot claims fine.
  const current = createWorld({ id: 'stale', persistence: adapter, fence: true });
  current.use(writeArticle);
  current.load((await adapter.load('stale')) as Snapshot);
  await expect(current.claim()).resolves.toBeUndefined();
});

test('R57 claim() refuses to pretend when the adapter cannot arbitrate', async () => {
  const world = createWorld({ id: 'noadapter' });
  await expect(world.claim()).rejects.toThrow(/needs a persistence adapter implementing fence/);
});

test('R57 fencing is opt-in, so time travel can still rewrite its own steps', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'tt', persistence: adapter });
  world.use(writeArticle);
  world.spawn(Topic('first'));
  await world.run();

  // Rewind and re-run: an unfenced world may legitimately rewrite step 2 (R38).
  // If the adapter's fence applied automatically, this would be refused.
  const rewound = createWorld({ id: 'tt', persistence: adapter });
  rewound.use(writeArticle);
  rewound.load((await adapter.loadStep('tt', 1)) as Snapshot);
  rewound.query(Topic)[0]?.set(Topic, 'divergent');
  await expect(rewound.run()).resolves.toMatchObject({ status: 'done' });
});

test('R58 saveEvery controls the write cadence; run end always persists', async () => {
  const counting = () => {
    const adapter = new MemoryAdapter();
    let saves = 0;
    const wrapped = {
      save: (s: Snapshot) => {
        saves += 1;
        adapter.save(s);
      },
      load: (id: string) => adapter.load(id),
      history: (id: string) => adapter.history(id),
      loadStep: (id: string, step: number) => adapter.loadStep(id, step),
    };
    return { wrapped, saves: () => saves, adapter };
  };

  // Four steps of work: one per entity, all in separate steps via a chain.
  const Step = defineComponent<number>({ name: 'evo.Step' });
  const advance = defineSystem({
    name: 'advance',
    query: [Step],
    run: (e, ctx) => {
      const at = e.get(Step);
      if (at >= 4) return;
      e.set(Step, at + 1);
      // A self-write never retriggers its own pair (R27), so the chain is driven
      // explicitly — and only while work remains, or the last re-arm would cost
      // an extra empty step.
      if (at + 1 < 4) ctx.invalidate(e, 'advance');
    },
  });

  const barrier = counting();
  const w1 = createWorld({ id: 'c1', persistence: barrier.wrapped, saveEvery: 'barrier' });
  w1.use(advance);
  w1.spawn(Step(0));
  await w1.run();
  // One write per committed step. The run-end save is skipped because nothing
  // changed after the last barrier — the engine used to write that boundary
  // twice.
  expect(w1.step).toBe(4);
  expect(barrier.saves()).toBe(4);
  expect(barrier.adapter.history('c1').map((h) => h.step)).toEqual([1, 2, 3, 4]);

  const quiet = counting();
  const w2 = createWorld({ id: 'c2', persistence: quiet.wrapped, saveEvery: 'quiescence' });
  w2.use(advance);
  w2.spawn(Step(0));
  await w2.run();
  // Exactly one write for the whole run — the cheap option for workloads that
  // do not need step-level time travel.
  expect(quiet.saves()).toBe(1);
  expect(quiet.adapter.history('c2').map((h) => h.step)).toEqual([w2.step]);

  const every2 = counting();
  const w3 = createWorld({ id: 'c3', persistence: every2.wrapped, saveEvery: 2 });
  w3.use(advance);
  w3.spawn(Step(0));
  await w3.run();
  // Steps 2 and 4 only; the run-end boundary is already step 4, so no extra write.
  expect(every2.adapter.history('c3').map((h) => h.step)).toEqual([2, 4]);
  expect(every2.saves()).toBe(2);
});

test('R58 quiescence cadence still persists an interrupted world at the pause', async () => {
  const adapter = new MemoryAdapter();
  const Ask = defineComponent<string>({ name: 'evo.Ask' });
  const asker = defineSystem({
    name: 'asker',
    query: [Ask],
    run: async (e, ctx) => {
      const model = ctx.resource<ReturnType<typeof scriptedModel>>('m');
      const res = await model.generate({ messages: [{ role: 'user', content: e.get(Ask) }] });
      e.set(Ask, res.message.content);
    },
  });
  const world = createWorld({ id: 'q', persistence: adapter, saveEvery: 'quiescence' });
  world.register('m', scriptedModel([{ role: 'assistant', content: 'answered' }]));
  world.use(asker);
  world.spawn(Ask('question'));

  await world.run();
  // Quiescence IS the pause in this engine, so the cadence that only writes at
  // quiescence still captures every boundary a human-in-the-loop flow resumes
  // from — what it gives up is the intermediate steps, i.e. time travel.
  const saved = (await adapter.load('q')) as Snapshot;
  expect(saved.step).toBe(world.step);
  expect(saved.entities[0]?.components['evo.Ask']).toBe('answered');
});

/** Minimal valid snapshot for migration-path tests. */
function emptySnapshot(): Snapshot {
  return {
    version: 1,
    worldId: 'evo',
    step: 0,
    nextEntityId: 1,
    entities: [],
    pendingPairs: [],
  };
}

// ---------------------------------------------------------------------------
// Regressions from the adversarial review of the shipped M3/M4/M6 work. Each of
// these failed against the code as first merged.
// ---------------------------------------------------------------------------

test('R58 a run that commits no step still persists changed state', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'idle', persistence: adapter });
  world.spawn(Topic('nothing matches this')); // no system registered

  const result = await world.run();
  expect(result.status).toBe('idle');
  // The revision skip used to make this write NOTHING at all: an entity spawned
  // and persisted-immediately, the documented "resume in another process" flow,
  // vanished because no step was committed.
  const stored = await adapter.load('idle');
  expect(stored?.entities).toHaveLength(1);
  expect(adapter.history('idle').map((h) => h.step)).toEqual([0]);
});

test('R50/R58 an idle cancel is persisted, so the world cannot resume un-cancelled', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'idlecancel', persistence: adapter });
  world.use(writeArticle);
  world.spawn(Topic('a'));
  await world.run();

  world.cancel('operator stopped'); // idle branch
  const result = await world.run();
  expect(result.status).toBe('cancelled');

  // Previously the stamp lived only in memory: the run reported 'cancelled' while
  // the store held a live world, so a restart resumed the work just stopped.
  const stored = (await adapter.load('idlecancel')) as Snapshot;
  const cancelled = stored.entities.filter((e) => 'Cancelled' in e.components);
  expect(cancelled).toHaveLength(1);

  const resumed = createWorld({ id: 'idlecancel' });
  resumed.use(writeArticle);
  resumed.load(stored);
  expect((await resumed.run()).status).toBe('cancelled');
});

test('R57 cancelling a FENCED world does not fence it out of its own step', async () => {
  const adapter = new MemoryAdapter();
  const slow = defineSystem({
    name: 'slowFenced',
    query: [Topic],
    run: async (_e, ctx) => {
      await delay(60_000, ctx.signal);
    },
  });
  const world = createWorld({ id: 'selffence', persistence: adapter, fence: true });
  world.use(slow);
  world.spawn(Topic('a'));
  await world.claim();

  const run = world.run();
  world.cancel('stop');
  // The fence is keyed on the step, the save on the revision. A cancellation
  // changes state WITHOUT advancing the step, so the run-end save re-claimed a
  // step this same world already owned and was refused — the run rejected with
  // FenceError naming a rival that did not exist, and the cancellation was lost.
  const result = await run;
  expect(result.status).toBe('cancelled');
  const stored = (await adapter.load('selffence')) as Snapshot;
  expect(stored.entities.some((e) => 'Cancelled' in e.components)).toBe(true);
});

test('R56 canLoad reports a throwing migration instead of propagating it', async () => {
  const world = createWorld({ id: 'evo', recipeVersion: 2 });
  world.migration(1, 2, () => {
    throw new Error('migration blew up');
  });
  const check = world.canLoad({ ...emptySnapshot(), recipeVersion: 1 });
  expect(check.ok).toBe(false);
  // R56 promises no side effects and nothing thrown; a broken migration is the
  // thing the deploy gate exists to catch, not a way to crash the pipeline.
  if (!check.ok) expect(check.migrationFailed?.error.message).toBe('migration blew up');
  // `load` still throws, which is correct — only the pre-flight is non-throwing.
  expect(() => world.load({ ...emptySnapshot(), recipeVersion: 1 })).toThrow(/blew up/);
});

test('R54 a migration chain must ascend, and must not overshoot the world', () => {
  const world = createWorld({ recipeVersion: 3 });
  expect(() => world.migration(9, 3, (s) => s)).toThrow(/does not move forward/);
  expect(() => world.migration(2, 2, (s) => s)).toThrow(/does not move forward/);
  // 1->9 in a v3 world used to be accepted, then walked a v1 snapshot up past the
  // schema this build understands and failed on a hop nobody wrote.
  expect(() => world.migration(1, 9, (s) => s)).toThrow(/overshoots this world's recipeVersion 3/);
  expect(() => world.migration(1, 2, (s) => s)).not.toThrow();
});

test('R55 a preserved value never resurrects after live code writes or removes it', async () => {
  const world = createWorld({ id: 'evict' });
  world.use(writeArticle);
  const entity = world.spawn(Topic('x'));
  await world.run();

  // A snapshot carrying a component name this build does not know yet.
  const raw: Snapshot = {
    ...world.snapshot(),
    worldId: 'evict',
    entities: [{ id: entity.id, components: { 'late.Owned': { keep: 'stale' } } }],
    pendingPairs: [],
  };
  const lenient = createWorld({ id: 'evict' });
  lenient.use(writeArticle);
  expect(lenient.load(raw, { strict: false }).preserved).toEqual([
    { entity: entity.id, component: 'late.Owned' },
  ]);
  // While nothing live owns the name it round-trips — that is R55 working.
  expect(lenient.snapshot().entities[0]?.components).toHaveProperty('late.Owned');

  // Now the deploy that owns it arrives (importing its module registers the name).
  const LateOwned = defineComponent<{ keep: string }>({ name: 'late.Owned' });

  // A live write must win, and must retire the stale copy.
  lenient.entity(entity.id)?.set(LateOwned, { keep: 'live' });
  expect(lenient.snapshot().entities[0]?.components['late.Owned']).toEqual({ keep: 'live' });

  // And a deliberate removal must STAY removed. Previously the next snapshot
  // re-emitted the other deployment's stale value, silently undoing the delete —
  // the exact inverse of what R55 promises.
  lenient.entity(entity.id)?.remove(LateOwned);
  expect(lenient.snapshot().entities[0]?.components).not.toHaveProperty('late.Owned');
});
