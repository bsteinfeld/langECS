// Standard reducers (R59), typed events (R60), model middleware (R61) and
// record/replay (R62). Zero network throughout.

import { expect, test } from 'vitest';
import {
  appendReducer,
  boundedAppend,
  createWorld,
  dedupeByReducer,
  defineComponent,
  defineEvent,
  defineSystem,
  delay,
  formatRecording,
  hashRequest,
  isEventRef,
  type Model,
  type ModelRequest,
  maxByReducer,
  mergeReducer,
  type Recording,
  type RunEvent,
  recordingModel,
  replayModel,
  scriptedModel,
  sumReducer,
  withCache,
  withCost,
  withFallback,
  withRateLimit,
  withRetry,
  withTimeout,
  wrapModel,
} from '../src/index';

// ------------------------------------------------------------------ R59

test('R59 the standard reducers merge as documented, without mutating their inputs', () => {
  const before = [1, 2];
  expect(appendReducer<number>()(before, [3])).toEqual([1, 2, 3]);
  // Purity matters: `current` is committed state, handed out by reference (R17).
  expect(before).toEqual([1, 2]);

  expect(mergeReducer<{ a?: number; b?: number }>()({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  expect(mergeReducer<{ a: number }>()({ a: 1 }, { a: 9 })).toEqual({ a: 9 });

  const score = maxByReducer<{ n: number }>((v) => v.n);
  expect(score({ n: 1 }, { n: 5 })).toEqual({ n: 5 });
  expect(score({ n: 5 }, { n: 1 })).toEqual({ n: 5 });
  // A tie keeps `current`, so the outcome cannot depend on barrier ordering.
  expect(score({ n: 5 }, { n: 5 })).toEqual({ n: 5 });

  const dedupe = dedupeByReducer<{ id: string }>((v) => v.id);
  expect(dedupe([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);

  expect(sumReducer()(3, 4)).toBe(7);
});

test('R59 boundedAppend caps growth from the chosen end', () => {
  const last = boundedAppend<number>(3);
  expect(last([1, 2, 3], [4])).toEqual([2, 3, 4]);
  expect(last([], [1, 2, 3, 4, 5])).toEqual([3, 4, 5]);

  const first = boundedAppend<number>(3, { keep: 'first' });
  expect(first([1, 2, 3], [4])).toEqual([1, 2, 3]);

  // Degenerate caps behave, rather than producing a negative slice.
  expect(boundedAppend<number>(0)([1], [2])).toEqual([]);
});

test('R59 a bounded component stays bounded across many concurrent writes', async () => {
  const Log = defineComponent<string[]>({ name: 'dx.Log', reducer: boundedAppend(2) });
  const Tick = defineComponent<number>({ name: 'dx.Tick' });
  const a = defineSystem({
    name: 'a',
    query: [Tick],
    run: (e) => {
      e.add(Log, ['a']);
    },
  });
  const b = defineSystem({
    name: 'b',
    query: [Tick],
    run: (e) => {
      e.add(Log, ['b']);
    },
  });
  const world = createWorld();
  world.use(a);
  world.use(b);
  const entity = world.spawn(Tick(1), Log(['seed']));
  await world.run();

  // Both pairs wrote in one step and the reducer merged them (no R30 conflict),
  // then the cap discarded the oldest.
  expect(world.entity(entity.id)?.get(Log)).toEqual(['a', 'b']);
});

// ------------------------------------------------------------------ R60

test('R60 a typed emit carries its event name; the untyped form is unchanged', async () => {
  const Token = defineEvent<{ text: string }>('token');
  const Phase = defineEvent<{ phase: string }>('phase');
  const Go = defineComponent<number>({ name: 'dx.Go' });

  const emitter = defineSystem({
    name: 'emitter',
    query: [Go],
    run: (_e, ctx) => {
      ctx.emit(Token, { text: 'hi' });
      ctx.emit(Phase, { phase: 'drafting' });
      ctx.emit({ kind: 'legacy', value: 1 });
    },
  });
  const world = createWorld();
  world.use(emitter);
  world.spawn(Go(1));

  const custom: Extract<RunEvent, { type: 'custom' }>[] = [];
  const run = world.run();
  for await (const event of run) {
    if (event.type === 'custom') custom.push(event);
  }

  expect(custom.map((e) => e.name)).toEqual(['token', 'phase', undefined]);
  expect(custom[0]?.data).toEqual({ text: 'hi' });
  // Observers can now filter by name instead of parsing every payload.
  expect(custom.filter((e) => e.name === 'phase').map((e) => e.data)).toEqual([
    { phase: 'drafting' },
  ]);
  // The untyped form still delivers its payload verbatim, with no name.
  expect(custom[2]?.data).toEqual({ kind: 'legacy', value: 1 });
});

test('R60 the ref check is a brand, so a payload with an eventName field is safe', async () => {
  expect(isEventRef(defineEvent('x'))).toBe(true);
  expect(isEventRef({ eventName: 'looks-like-one' })).toBe(false);

  const Go = defineComponent<number>({ name: 'dx.Go2' });
  const sneaky = defineSystem({
    name: 'sneaky',
    query: [Go],
    run: (_e, ctx) => {
      // A structural check would read this as a typed emit, silently swap the
      // name and drop the payload.
      ctx.emit({ eventName: 'not-a-ref', payload: 'kept' });
    },
  });
  const world = createWorld();
  world.use(sneaky);
  world.spawn(Go(1));
  const seen: unknown[] = [];
  for await (const event of world.run()) {
    if (event.type === 'custom') seen.push({ name: event.name, data: event.data });
  }
  expect(seen).toEqual([{ name: undefined, data: { eventName: 'not-a-ref', payload: 'kept' } }]);
});

// ------------------------------------------------------------------ R61

/** A model that fails its first `failures` calls, then succeeds. */
function flakyModel(failures: number, text = 'ok'): Model & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async generate() {
      calls += 1;
      if (calls <= failures) throw new Error(`provider blip ${calls}`);
      return { message: { role: 'assistant', content: text }, finishReason: 'stop' };
    },
  };
}

test('R61 wrapModel composes first-listed-outermost', async () => {
  const order: string[] = [];
  const tag =
    (name: string) =>
    (inner: Model): Model => ({
      generate: async (req) => {
        order.push(name);
        return inner.generate(req);
      },
    });
  const model = wrapModel(scriptedModel([{ role: 'assistant', content: 'x' }]), tag('a'), tag('b'));
  await model.generate({ messages: [] });
  // Same convention as observer wrapSystemRun (R46).
  expect(order).toEqual(['a', 'b']);
});

test('R61 withRetry retries a blip, gives up past max, and NEVER retries a cancellation', async () => {
  const flaky = flakyModel(2, 'recovered');
  const model = wrapModel(flaky, withRetry({ max: 3, baseMs: 1 }));
  const result = await model.generate({ messages: [] });
  expect(result.message.content).toBe('recovered');
  expect(flaky.calls()).toBe(3);

  const hopeless = flakyModel(10);
  await expect(
    wrapModel(hopeless, withRetry({ max: 2, baseMs: 1 })).generate({ messages: [] }),
  ).rejects.toThrow(/provider blip/);
  expect(hopeless.calls()).toBe(3); // first attempt + 2 retries

  // Retrying an aborted call would defeat world.cancel() and every timeoutMs
  // budget above it.
  const controller = new AbortController();
  let attempts = 0;
  const aborting: Model = {
    generate: async () => {
      attempts += 1;
      controller.abort();
      throw new Error('aborted mid-call');
    },
  };
  await expect(
    wrapModel(aborting, withRetry({ max: 5, baseMs: 1 })).generate({
      messages: [],
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(attempts).toBe(1);
});

test('R61 withRetry retries a stream only before the first chunk', async () => {
  // Fails after emitting: retrying would replay tokens the consumer already saw.
  let calls = 0;
  const halfStreamed: Model = {
    generate: async () => ({ message: { role: 'assistant', content: '' } }),
    stream: async (_req, onChunk) => {
      calls += 1;
      onChunk({ text: 'par' });
      throw new Error('died mid-stream');
    },
  };
  const chunks: string[] = [];
  await expect(
    wrapModel(halfStreamed, withRetry({ max: 3, baseMs: 1 })).stream?.({ messages: [] }, (d) => {
      if (d.text !== undefined) chunks.push(d.text);
    }),
  ).rejects.toThrow(/died mid-stream/);
  expect(calls).toBe(1);
  expect(chunks).toEqual(['par']);

  // Fails before emitting: safe to retry, and the consumer sees one clean stream.
  let tries = 0;
  const failsEarly: Model = {
    generate: async () => ({ message: { role: 'assistant', content: '' } }),
    stream: async (_req, onChunk) => {
      tries += 1;
      if (tries === 1) throw new Error('connection reset');
      onChunk({ text: 'clean' });
      return { message: { role: 'assistant', content: 'clean' } };
    },
  };
  const good: string[] = [];
  const result = await wrapModel(failsEarly, withRetry({ max: 3, baseMs: 1 })).stream?.(
    { messages: [] },
    (d) => {
      if (d.text !== undefined) good.push(d.text);
    },
  );
  expect(result?.message.content).toBe('clean');
  expect(good).toEqual(['clean']);
});

test('R61 withTimeout aborts the inner call rather than merely un-awaiting it', async () => {
  let innerSawAbort = false;
  const slow: Model = {
    generate: async (req) => {
      await delay(60_000, req.signal).catch((err) => {
        innerSawAbort = req.signal?.aborted === true;
        throw err;
      });
      return { message: { role: 'assistant', content: 'never' } };
    },
  };
  await expect(wrapModel(slow, withTimeout(10)).generate({ messages: [] })).rejects.toThrow(
    /exceeded its 10ms timeout/,
  );
  expect(innerSawAbort).toBe(true);
});

test('R61 withTimeout still propagates the caller cancellation', async () => {
  const slow: Model = {
    generate: async (req) => {
      await delay(60_000, req.signal);
      return { message: { role: 'assistant', content: 'never' } };
    },
  };
  const controller = new AbortController();
  const pending = wrapModel(slow, withTimeout(60_000)).generate({
    messages: [],
    signal: controller.signal,
  });
  controller.abort(new Error('user stopped'));
  await expect(pending).rejects.toThrow('user stopped');
});

test('R61 withFallback switches models on failure but never mid-answer', async () => {
  const primary = flakyModel(10);
  const backup = scriptedModel([{ role: 'assistant', content: 'from the backup' }]);
  const result = await wrapModel(primary, withFallback(backup)).generate({ messages: [] });
  expect(result.message.content).toBe('from the backup');

  // Half-streamed: splicing a second model's answer onto the first would produce
  // a reply that neither model actually gave.
  const halfStreamed: Model = {
    generate: async () => ({ message: { role: 'assistant', content: '' } }),
    stream: async (_req, onChunk) => {
      onChunk({ text: 'half ' });
      throw new Error('died mid-stream');
    },
  };
  const chunks: string[] = [];
  await expect(
    wrapModel(halfStreamed, withFallback(backup)).stream?.({ messages: [] }, (d) => {
      if (d.text !== undefined) chunks.push(d.text);
    }),
  ).rejects.toThrow(/died mid-stream/);
  expect(chunks).toEqual(['half ']);
});

test('R61 a layer after withFallback sees only the primary — the ordering trap', async () => {
  const backup: Model = {
    generate: async () => ({
      message: { role: 'assistant', content: 'from the backup' },
      usage: { inputTokens: 5, outputTokens: 5 },
    }),
  };
  // Verified against a real failing provider: this is the order everyone writes
  // first (it is the order in the original proposal), and the ledger stays empty
  // in exactly the case you most want to measure.
  const inside: number[] = [];
  const wrong = wrapModel(
    flakyModel(10),
    withFallback(backup),
    withCost((r) => inside.push(r.ms)),
  );
  expect((await wrong.generate({ messages: [] })).message.content).toBe('from the backup');
  expect(inside).toEqual([]);

  // Observability outermost sees whichever model actually answered.
  const outside: number[] = [];
  const right = wrapModel(
    flakyModel(10),
    withCost((r) => outside.push(r.ms)),
    withFallback(backup),
  );
  expect((await right.generate({ messages: [] })).message.content).toBe('from the backup');
  expect(outside).toHaveLength(1);
});

test('R61 withCost reports usage for successful calls only', async () => {
  const reports: { total: number; ms: number }[] = [];
  const usable: Model = {
    generate: async () => ({
      message: { role: 'assistant', content: 'hi' },
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: 'stop',
    }),
  };
  const model = wrapModel(
    usable,
    withCost((r) => {
      reports.push({ total: (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0), ms: r.ms });
    }),
  );
  await model.generate({ messages: [] });
  await model.generate({ messages: [] });
  expect(reports.map((r) => r.total)).toEqual([14, 14]);
  expect(reports[0]?.ms).toBeGreaterThanOrEqual(0);

  // A failure has no usage to report.
  const failing = wrapModel(
    flakyModel(10),
    withCost(() => reports.push({ total: -1, ms: 0 })),
  );
  await expect(failing.generate({ messages: [] })).rejects.toThrow();
  expect(reports).toHaveLength(2);
});

test('R61 withCache serves identical requests and ignores the signal in the key', async () => {
  let calls = 0;
  const counting: Model = {
    generate: async () => {
      calls += 1;
      return { message: { role: 'assistant', content: `call ${calls}` } };
    },
  };
  const model = wrapModel(counting, withCache());
  const req: ModelRequest = { messages: [{ role: 'user', content: 'same' }] };

  expect((await model.generate(req)).message.content).toBe('call 1');
  expect((await model.generate(req)).message.content).toBe('call 1');
  // A different signal is the same question — keying on it would make every call
  // unique and the cache pointless.
  const controller = new AbortController();
  expect((await model.generate({ ...req, signal: controller.signal })).message.content).toBe(
    'call 1',
  );
  expect(calls).toBe(1);

  // Property order must not matter either.
  const reordered: ModelRequest = { system: 'x', messages: req.messages };
  const withSystem: ModelRequest = { messages: req.messages, system: 'x' };
  expect(hashRequest(reordered)).toBe(hashRequest(withSystem));

  // A different request is a different key.
  expect(
    (await model.generate({ messages: [{ role: 'user', content: 'other' }] })).message.content,
  ).toBe('call 2');
});

test('R61 withCache expires entries after ttlMs and never caches a failure', async () => {
  // Real timers with a tiny TTL: the cache clock is `performance.now()`, which
  // vitest's fake timers do not advance.
  let calls = 0;
  const counting: Model = {
    generate: async () => {
      calls += 1;
      return { message: { role: 'assistant', content: `call ${calls}` } };
    },
  };
  const model = wrapModel(counting, withCache({ ttlMs: 10 }));
  await model.generate({ messages: [] });
  await model.generate({ messages: [] });
  expect(calls).toBe(1);
  await delay(25);
  await model.generate({ messages: [] });
  expect(calls).toBe(2);

  // Caching an error would turn one blip into a permanently poisoned answer.
  const flaky = flakyModel(1, 'eventually');
  const cached = wrapModel(flaky, withCache());
  await expect(cached.generate({ messages: [] })).rejects.toThrow();
  expect((await cached.generate({ messages: [] })).message.content).toBe('eventually');
});

test('R61 withRateLimit caps concurrency and spaces out calls', async () => {
  let inFlight = 0;
  let peak = 0;
  const tracked: Model = {
    generate: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;
      return { message: { role: 'assistant', content: 'ok' } };
    },
  };
  const model = wrapModel(tracked, withRateLimit({ concurrency: 2 }));
  await Promise.all(Array.from({ length: 6 }, () => model.generate({ messages: [] })));
  expect(peak).toBeLessThanOrEqual(2);

  const spaced = wrapModel(
    { generate: async () => ({ message: { role: 'assistant' as const, content: 'ok' } }) },
    withRateLimit({ minIntervalMs: 20 }),
  );
  const started = Date.now();
  await spaced.generate({ messages: [] });
  await spaced.generate({ messages: [] });
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);
});

test('R61 withRateLimit: an aborted queued call never strands the calls behind it', async () => {
  // Regression: the post-wake abort check used to sit OUTSIDE the try/finally, so
  // a waiter that aborted after being handed a slot swallowed the baton and every
  // remaining queued call hung forever.
  const completed: string[] = [];
  const slow: Model = {
    generate: async (req) => {
      await delay(15, req.signal);
      return { message: { role: 'assistant', content: 'done' } };
    },
  };
  const model = wrapModel(slow, withRateLimit({ concurrency: 1 }));

  const cancelSecond = new AbortController();
  const first = model.generate({ messages: [] }).then(() => completed.push('first'));
  // Both of these queue behind `first`.
  const second = model.generate({ messages: [], signal: cancelSecond.signal }).then(
    () => completed.push('second'),
    () => completed.push('second:aborted'),
  );
  const third = model.generate({ messages: [] }).then(() => completed.push('third'));

  cancelSecond.abort();
  await Promise.all([first, second, third]);

  // The third call is the point: it must still get its turn.
  expect(completed).toContain('third');
  expect(completed).toContain('first');
  expect(completed).toContain('second:aborted');

  // The gate is not wedged — a later call still goes through.
  await expect(model.generate({ messages: [] })).resolves.toMatchObject({
    message: { content: 'done' },
  });
});

test('R61 withRateLimit releases the slot when the call itself throws', async () => {
  const model = wrapModel(flakyModel(1, 'recovered'), withRateLimit({ concurrency: 1 }));
  await expect(model.generate({ messages: [] })).rejects.toThrow(/provider blip/);
  // A thrown call must hand its slot back, or capacity leaks one per failure.
  await expect(model.generate({ messages: [] })).resolves.toMatchObject({
    message: { content: 'recovered' },
  });
});

test('R61 middleware that only wraps generate keeps the model streamable', async () => {
  const streaming = scriptedModel([{ role: 'assistant', content: 'streamed' }]);
  // withCost/withRetry etc. must not silently strip `stream` — stdlib's callLLM
  // branches on its presence, so tokens would just stop appearing.
  const wrapped = wrapModel(
    streaming,
    withCost(() => {}),
    withRetry({ max: 1, baseMs: 1 }),
  );
  expect(typeof wrapped.stream).toBe('function');
  const chunks: string[] = [];
  const result = await wrapped.stream?.({ messages: [] }, (d) => {
    if (d.text !== undefined) chunks.push(d.text);
  });
  expect(result?.message.content).toBe('streamed');
  expect(chunks.join('')).toBe('streamed');

  // …and a non-streaming model stays non-streaming.
  const plain = wrapModel(
    { generate: async () => ({ message: { role: 'assistant' as const, content: 'x' } }) },
    withCost(() => {}),
  );
  expect(plain.stream).toBeUndefined();
});

// ------------------------------------------------------------------ R62

test('R62 a recorded run replays exactly, matching on request hash', async () => {
  const live = scriptedModel([
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', args: { q: 'x' } }] },
    { role: 'assistant', content: 'the answer' },
  ]);
  const recorder = recordingModel(live);

  const first: ModelRequest = { messages: [{ role: 'user', content: 'question' }] };
  const second: ModelRequest = {
    messages: [
      { role: 'user', content: 'question' },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ],
  };
  await recorder.generate(first);
  await recorder.generate(second);

  const recording = recorder.recording();
  expect(recording.entries).toHaveLength(2);
  // A recording is plain JSON, so it is a checkable fixture.
  expect(JSON.parse(JSON.stringify(recording))).toEqual(recording);

  // Replay out of order: hash matching means call order may differ (R29).
  const replay = replayModel(recording, { strict: true });
  expect((await replay.generate(second)).message.content).toBe('the answer');
  expect((await replay.generate(first)).message.toolCalls?.[0]?.name).toBe('search');
});

test('R62 a prompt edit falls back to ordinal matching, and strict mode refuses', async () => {
  const recorder = recordingModel(
    scriptedModel([
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]),
  );
  await recorder.generate({ messages: [{ role: 'user', content: 'v1 prompt' }] });
  await recorder.generate({ messages: [{ role: 'user', content: 'v1 prompt again' }] });
  const recording = recorder.recording();

  // The prompt has been edited, so nothing hash-matches. This is the case a
  // pure content-addressed replay cannot serve at all.
  const edited = { messages: [{ role: 'user' as const, content: 'v2 prompt' }] };
  const mismatches: { index: number }[] = [];
  const lenient = replayModel(recording, { onMismatch: (i) => mismatches.push(i) });
  expect((await lenient.generate(edited)).message.content).toBe('first');
  expect((await lenient.generate(edited)).message.content).toBe('second');
  expect(mismatches.map((m) => m.index)).toEqual([0, 1]);

  // In CI you want to hear about the drift instead.
  const strict = replayModel(recording, { strict: true });
  await expect(strict.generate(edited)).rejects.toThrow(/prompts have drifted from this fixture/);
});

test('R62 replay is exhaustible, entries are consumed once, and results are detached', async () => {
  const recorder = recordingModel(scriptedModel([{ role: 'assistant', content: 'only' }]));
  const req = { messages: [{ role: 'user' as const, content: 'q' }] };
  await recorder.generate(req);
  const recording = recorder.recording();

  const replay = replayModel(recording);
  const result = await replay.generate(req);
  expect(result.message.content).toBe('only');
  // Mutating a replayed message must not corrupt the fixture for the next replay.
  result.message.content = 'tampered';
  expect(recording.entries[0]?.result.message.content).toBe('only');
  // One recorded call answers exactly one call.
  await expect(replay.generate(req)).rejects.toThrow(/exhausted/);
});

test('R62 a recorded stream replays re-chunked, and the sink sees progress', async () => {
  const captured: Recording[] = [];
  const recorder = recordingModel(
    scriptedModel([{ role: 'assistant', content: 'streamed answer' }]),
    (r) => captured.push(r),
  );
  const req = { messages: [{ role: 'user' as const, content: 'q' }] };
  const live: string[] = [];
  await recorder.stream?.(req, (d) => {
    if (d.text !== undefined) live.push(d.text);
  });
  // The sink fires per captured call, so a crashed run still leaves a fixture.
  expect(captured).toHaveLength(1);
  expect(captured[0]?.entries[0]?.via).toBe('stream');

  const replayed: string[] = [];
  const result = await replayModel(captured[0] as Recording).stream?.(req, (d) => {
    if (d.text !== undefined) replayed.push(d.text);
  });
  expect(result?.message.content).toBe('streamed answer');
  // Chunk boundaries are a network artefact, so replay re-chunks rather than
  // pretending to preserve them.
  expect(replayed.join('')).toBe('streamed answer');
  expect(replayed.length).toBeGreaterThan(1);
});

test('R62 recordings drop provider `raw` so the fixture stays JSON, and format readably', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const withRaw: Model = {
    generate: async () => ({
      message: { role: 'assistant', content: 'hi' },
      usage: { inputTokens: 1, outputTokens: 2 },
      finishReason: 'stop',
      raw: circular, // a provider response, often circular
    }),
  };
  const recorder = recordingModel(withRaw);
  await recorder.generate({ messages: [{ role: 'user', content: 'q' }] });
  const recording = recorder.recording();

  expect(recording.entries[0]?.result.raw).toBeUndefined();
  expect(recording.entries[0]?.result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  expect(() => JSON.stringify(recording)).not.toThrow();

  const text = formatRecording(recording);
  expect(text).toContain('recording v1: 1 call(s)');
  expect(text).toContain('← user: q');
  expect(text).toContain('→ assistant: hi');
});

test('R62 replay drives a real world, so a recorded run becomes a regression test', async () => {
  const Question = defineComponent<string>({ name: 'dx.Question' });
  const Answer = defineComponent<string>({ name: 'dx.Answer' });
  const ask = defineSystem({
    name: 'ask',
    query: [Question],
    run: async (e, ctx) => {
      const model = ctx.resource<Model>('model');
      const res = await model.generate({ messages: [{ role: 'user', content: e.get(Question) }] });
      e.set(Answer, res.message.content);
    },
  });

  const build = (model: Model) => {
    const world = createWorld();
    world.use(ask);
    world.register('model', model);
    return { world, entity: world.spawn(Question('why?')) };
  };

  // Record against a "live" model…
  const recorder = recordingModel(scriptedModel([{ role: 'assistant', content: 'because' }]));
  const live = build(recorder);
  await live.world.run();
  expect(live.world.entity(live.entity.id)?.get(Answer)).toBe('because');

  // …then replay it with no model at all. Because state is data and scheduling is
  // deterministic, the recorded run really does replay.
  const replayed = build(replayModel(recorder.recording(), { strict: true }));
  await replayed.world.run();
  expect(replayed.world.entity(replayed.entity.id)?.get(Answer)).toBe('because');
  expect(replayed.world.getTrace().map((s) => s.runs.map((r) => r.system))).toEqual(
    live.world.getTrace().map((s) => s.runs.map((r) => r.system)),
  );
});
