// Cooperative-cancellation primitives (R49) and the abort-aware scriptedModel
// (R44 amended). Zero network, zero timers longer than a few ms.

import { expect, test, vi } from 'vitest';
import {
  abortReason,
  anySignal,
  CancelledError,
  delay,
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

test('R51 anySignal aborts as soon as any input does', () => {
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
