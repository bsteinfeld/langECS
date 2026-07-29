// Cooperative-cancellation primitives (R49) and the abort-aware scriptedModel
// (R44 amended). Zero network, zero timers longer than a few ms.

import { expect, test, vi } from 'vitest';
import {
  abortReason,
  anySignal,
  CancelledError,
  delay,
  type Msg,
  scriptedModel,
  throwIfAborted,
} from '../src/index';

test('R49 throwIfAborted is a no-op for a live or absent signal', () => {
  expect(() => throwIfAborted(undefined)).not.toThrow();
  expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
});

test('R49 throwIfAborted re-throws the platform reason, falling back to CancelledError', () => {
  const controller = new AbortController();
  controller.abort();
  // Node populates `reason` with an AbortError DOMException; that is what
  // consumers switching on `err.name === 'AbortError'` expect to see.
  expect(() => throwIfAborted(controller.signal)).toThrow();
  try {
    throwIfAborted(controller.signal);
    expect.unreachable();
  } catch (err) {
    expect((err as Error).name).toBe('AbortError');
  }

  const custom = new AbortController();
  const sentinel = new Error('budget exhausted');
  custom.abort(sentinel);
  expect(() => throwIfAborted(custom.signal)).toThrow(sentinel);

  // A signal with no `reason` at all (exotic runtime) still produces an error.
  const bare = { aborted: true } as AbortSignal;
  expect(abortReason(bare)).toBeInstanceOf(CancelledError);
});

test('R49 delay resolves normally and rejects the instant its signal aborts', async () => {
  await expect(delay(1)).resolves.toBeUndefined();

  const controller = new AbortController();
  const pending = delay(60_000, controller.signal);
  controller.abort(new Error('stop'));
  await expect(pending).rejects.toThrow('stop');

  // Already aborted: rejects without arming a timer.
  const done = new AbortController();
  done.abort();
  await expect(delay(60_000, done.signal)).rejects.toThrow();
});

test('R49 delay clears its timer when aborted, leaving nothing pending', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const pending = delay(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The pending timer is gone, so an aborted delay leaks nothing that could
    // keep a process (or a test runner) alive.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('R49 anySignal aborts as soon as any input does', () => {
  expect(anySignal([])).toBeUndefined();
  expect(anySignal([undefined, undefined])).toBeUndefined();

  const only = new AbortController();
  // A single signal is passed through unchanged — no wrapper, no listener.
  expect(anySignal([only.signal, undefined])).toBe(only.signal);

  const a = new AbortController();
  const b = new AbortController();
  const combined = anySignal([a.signal, b.signal]);
  expect(combined?.aborted).toBe(false);
  b.abort(new Error('second one'));
  expect(combined?.aborted).toBe(true);

  // An input that is already aborted yields an already-aborted result.
  const dead = new AbortController();
  dead.abort();
  expect(anySignal([dead.signal, new AbortController().signal])?.aborted).toBe(true);
});

/**
 * A minimal `AbortSignal` stand-in that records listener add/remove calls, so
 * teardown is assertable without reaching into runtime internals.
 */
function fakeSignal(): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  const state = { aborted: false, reason: undefined as unknown };
  const signal = {
    get aborted() {
      return state.aborted;
    },
    get reason() {
      return state.reason;
    },
    addEventListener(_type: 'abort', listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'abort', listener: () => void) {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort(reason?: unknown) {
      state.aborted = true;
      state.reason = reason;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** Runs `fn` with the platform's `AbortSignal.any` hidden, forcing the fallback. */
function withoutNativeAny(fn: () => void): void {
  const holder = AbortSignal as unknown as { any?: unknown };
  const original = holder.any;
  holder.any = undefined;
  try {
    fn();
  } finally {
    holder.any = original;
  }
}

test('R49 anySignal fallback removes every listener once the composite aborts', () => {
  withoutNativeAny(() => {
    const a = fakeSignal();
    const b = fakeSignal();
    const combined = anySignal([a.signal, b.signal]);
    // Fallback path: one listener per input while the composite is live.
    expect(a.listenerCount()).toBe(1);
    expect(b.listenerCount()).toBe(1);

    const reason = new Error('b won the race');
    b.abort(reason);
    expect(combined?.aborted).toBe(true);
    expect((combined as unknown as { reason?: unknown }).reason).toBe(reason);
    // The whole listener set is torn down — including the input that did NOT
    // fire, which would otherwise retain this composite for its own lifetime.
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(0);
  });
});

test('R49 anySignal fallback leaves nothing attached when an input is already aborted', () => {
  withoutNativeAny(() => {
    const live = fakeSignal();
    const dead = fakeSignal();
    dead.abort(new Error('already gone'));
    // `live` is visited (and listened to) before `dead` is discovered aborted.
    const combined = anySignal([live.signal, dead.signal]);
    expect(combined?.aborted).toBe(true);
    expect(live.listenerCount()).toBe(0);
  });
});

test('R49 anySignal fallback does not accumulate listeners across repeated composes', () => {
  withoutNativeAny(() => {
    const runWide = fakeSignal();
    for (let step = 0; step < 25; step++) {
      const perStep = fakeSignal();
      const combined = anySignal([runWide.signal, perStep.signal]);
      perStep.abort(new Error(`step ${step} deadline`));
      expect(combined?.aborted).toBe(true);
    }
    // The long-lived signal is back to zero after every step, rather than
    // carrying one stale listener (and one retained controller) per step.
    expect(runWide.listenerCount()).toBe(0);
  });
});

test('R44 scriptedModel rejects on an aborted signal WITHOUT consuming a turn', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second' },
  ]);
  const controller = new AbortController();
  controller.abort();

  await expect(model.generate({ messages: [], signal: controller.signal })).rejects.toThrow();
  // The script must still be aligned: a cancelled call that ate 'first' would
  // silently shift every later assertion in a choreography test.
  const result = await model.generate({ messages: [] });
  expect(result.message.content).toBe('first');
});

test('R44 scriptedModel delayMs is interruptible mid-call', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'slow' }], { delayMs: 60_000 });
  const controller = new AbortController();
  const pending = model.generate({ messages: [], signal: controller.signal });
  controller.abort(new Error('timed out'));
  await expect(pending).rejects.toThrow('timed out');
});

test('R44 scriptedModel an abort during the delayMs wait consumes no turn', async () => {
  const model = scriptedModel(
    [
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
    // Short, because `delayMs` applies to the retry below too. The abort still
    // lands during the wait: `delay` arms its listener synchronously, well
    // before this timer could fire.
    { delayMs: 5 },
  );
  const controller = new AbortController();
  const pending = model.generate({ messages: [], signal: controller.signal });
  controller.abort(new Error('timed out'));
  await expect(pending).rejects.toThrow('timed out');

  // The turn is consumed only when a reply is delivered, so the timed-out call
  // left the script untouched — this is the realistic cancellation shape (a
  // deadline firing mid-flight), and a retry must see the reply it was denied.
  const retry = await model.generate({ messages: [] });
  expect(retry.message.content).toBe('first');
});

test('R44 scriptedModel an abort while an async turn resolves consumes no turn', async () => {
  const model = scriptedModel([
    async () => {
      await delay(5);
      return { role: 'assistant', content: 'first' };
    },
    { role: 'assistant', content: 'second' },
  ]);
  const controller = new AbortController();
  const pending = model.generate({ messages: [], signal: controller.signal });
  // Abort while the turn function is still in flight: the scripted call is the
  // documented way to stand in for a slow provider, so it must reject rather
  // than deliver the reply it already computed.
  controller.abort(new Error('cancelled mid-turn'));
  await expect(pending).rejects.toThrow('cancelled mid-turn');

  const retry = await model.generate({ messages: [] });
  expect(retry.message.content).toBe('first');
});

test('R44 scriptedModel a never-settling turn rejects on abort and is re-invoked on retry', async () => {
  let invocations = 0;
  // Exactly ONE turn scripted, so if the aborted call consumed it the retry
  // would fail with "scriptedModel exhausted" instead of delivering.
  const model = scriptedModel([
    () => {
      invocations += 1;
      // R44's way to script a call only a timeout can end: awaiting this
      // directly would hang the test rather than cancel it.
      return invocations === 1
        ? new Promise<Msg>(() => {})
        : Promise.resolve({ role: 'assistant' as const, content: 'delivered on retry' });
    },
  ]);

  const controller = new AbortController();
  const reason = new Error('deadline');
  const pending = model.generate({ messages: [], signal: controller.signal });
  await Promise.resolve(); // let the turn function start
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(invocations).toBe(1);

  // Same turn, invoked again, and this time its reply lands — proving the
  // cancelled call consumed nothing.
  const retry = await model.generate({ messages: [] });
  expect(retry.message.content).toBe('delivered on retry');
  expect(invocations).toBe(2);
});

test('R44 scriptedModel detaches its abort listener once a raced turn settles', async () => {
  const outer = fakeSignal();
  const model = scriptedModel([async () => ({ role: 'assistant', content: 'ok' })]);
  const result = await model.generate({ messages: [], signal: outer.signal });
  expect(result.message.content).toBe('ok');
  // A long-lived signal must not accumulate one listener per scripted call.
  expect(outer.listenerCount()).toBe(0);
});

test('R44 scriptedModel concurrent calls take distinct turns in call order', async () => {
  // Several pairs can call the model in one step (the code-review-crew shape).
  // Claiming a turn must not wait on the await, or they all get turn 0.
  const model = scriptedModel([
    async () => {
      await delay(15);
      return { role: 'assistant', content: 'first' };
    },
    async () => {
      await delay(5);
      return { role: 'assistant', content: 'second' };
    },
    { role: 'assistant', content: 'third' },
  ]);
  const replies = await Promise.all([
    model.generate({ messages: [] }),
    model.generate({ messages: [] }),
    model.generate({ messages: [] }),
  ]);
  expect(replies.map((r) => r.message.content)).toEqual(['first', 'second', 'third']);
});

test('R44 scriptedModel a cancelled concurrent call returns only its own turn', async () => {
  const model = scriptedModel([
    // Async, so this call is still in flight when the abort lands.
    async () => {
      await delay(10);
      return { role: 'assistant', content: 'first' };
    },
    { role: 'assistant', content: 'second' },
  ]);
  const controller = new AbortController();
  // Two concurrent calls claim turns 0 and 1; the first is then cancelled.
  const cancelled = model.generate({ messages: [], signal: controller.signal });
  const survivor = model.generate({ messages: [] });
  controller.abort(new Error('gone'));
  await expect(cancelled).rejects.toThrow('gone');
  expect((await survivor).message.content).toBe('second');
  // Only the cancelled call's slot came back, so the retry gets 'first' — not
  // 'second' again, and not an exhaustion error.
  expect((await model.generate({ messages: [] })).message.content).toBe('first');
});

test('R44 scriptedModel accepts async turn functions (a slow scripted call)', async () => {
  const model = scriptedModel([
    async (req) => ({ role: 'assistant', content: `async:${req.messages.length}` }),
  ]);
  const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
  expect(result.message.content).toBe('async:1');
});

test('R44 scriptedModel stops streaming chunks once aborted', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'abcdefgh' }]);
  const controller = new AbortController();
  const chunks: string[] = [];
  await expect(
    model.stream?.({ messages: [], signal: controller.signal }, (d) => {
      if (d.text !== undefined) chunks.push(d.text);
      // Abort partway through: the next chunk boundary must throw.
      controller.abort();
    }),
  ).rejects.toThrow();
  expect(chunks).toEqual(['ab']);
});
