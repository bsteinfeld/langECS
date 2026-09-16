import { expect, test } from 'vitest';
import {
  type ModelResult,
  recordingModel,
  replayModel,
  scriptedModel,
  withCache,
  withRateLimit,
  wrapModel,
} from '../src/index';

test('R61 cache accepts a successful provider result with circular raw data', async () => {
  const raw: Record<string, unknown> = {};
  raw.self = raw;
  const model = wrapModel(
    { generate: async () => ({ message: { role: 'assistant' as const, content: 'ok' }, raw }) },
    withCache(),
  );
  await expect(model.generate({ messages: [] })).resolves.toMatchObject({
    message: { content: 'ok' },
  });
});

test('R62 recorder detaches captured result from the successful call', async () => {
  const recorder = recordingModel(scriptedModel([{ role: 'assistant', content: 'original' }]));
  const result = await recorder.generate({ messages: [] });
  result.message.content = 'mutated by caller';
  expect(recorder.recording().entries[0]!.result.message.content).toBe('original');
});

test('R62 recording ordinal follows invocation order for concurrent identical prompts', async () => {
  let finishFirst!: (result: ModelResult) => void;
  let calls = 0;
  const recorder = recordingModel({
    generate: async () => {
      if (++calls === 1)
        return new Promise<ModelResult>((r) => {
          finishFirst = r;
        });
      return { message: { role: 'assistant', content: 'second' } };
    },
  });
  const first = recorder.generate({ messages: [] });
  await recorder.generate({ messages: [] });
  finishFirst({ message: { role: 'assistant', content: 'first' } });
  await first;
  const replay = replayModel(recorder.recording(), { strict: true });
  expect((await replay.generate({ messages: [] })).message.content).toBe('first');
});

test('R49 replay rejects cancellation without consuming a recorded turn', async () => {
  const recorder = recordingModel(scriptedModel([{ role: 'assistant', content: 'one' }]));
  await recorder.generate({ messages: [] });
  const replay = replayModel(recorder.recording());
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await expect(replay.generate({ messages: [], signal: stop.signal })).rejects.toThrow('stopped');
  expect((await replay.generate({ messages: [] })).message.content).toBe('one');
});

test('R61 rate-limit hands an occupied slot to its waiter before admitting newcomers', async () => {
  const finish: (() => void)[] = [];
  let active = 0;
  let maxActive = 0;
  const model = wrapModel(
    {
      generate: () => {
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<ModelResult>((r) =>
          finish.push(() => {
            active--;
            r({ message: { role: 'assistant', content: 'ok' } });
          }),
        );
      },
    },
    withRateLimit({ concurrency: 1 }),
  );
  const a = model.generate({ messages: [] });
  const b = model.generate({ messages: [] });
  finish[0]!();
  const c = Promise.resolve().then(() => model.generate({ messages: [] }));
  await a;
  await Promise.resolve();
  finish[1]!();
  await Promise.resolve();
  await Promise.resolve();
  finish[2]!();
  await Promise.all([b, c]);
  expect(maxActive).toBe(1);
});

test('R61 a streaming cache omits circular raw and detaches its stored result', async () => {
  let calls = 0;
  const raw: Record<string, unknown> = {};
  raw.self = raw;
  const generate = async (): Promise<ModelResult> => {
    calls++;
    return { message: { role: 'assistant', content: 'portable' }, raw };
  };
  const model = wrapModel({ generate, stream: generate }, withCache());
  const first = await model.stream!({ messages: [] }, () => {});
  first.message.content = 'mutated';
  const chunks: string[] = [];
  const hit = await model.stream!({ messages: [] }, (c) => chunks.push(c.text ?? ''));
  expect(calls).toBe(1);
  expect(hit.message.content).toBe('portable');
  expect(hit.raw).toBeUndefined();
  expect(chunks).toEqual(['portable']);
});

test('R62 sinks cannot mutate captured requests, results, or usage', async () => {
  const recorder = recordingModel(
    {
      generate: async () => ({
        message: { role: 'assistant' as const, content: 'answer' },
        usage: { inputTokens: 1 },
      }),
    },
    (entry) => {
      entry.request.messages[0]!.content = 'sink prompt';
      entry.result.message.content = 'sink answer';
      entry.result.usage!.inputTokens = 99;
    },
  );
  const result = await recorder.generate({ messages: [{ role: 'user', content: 'question' }] });
  result.usage!.inputTokens = 42;
  expect(recorder.recording().entries[0]).toMatchObject({
    request: { messages: [{ content: 'question' }] },
    result: { message: { content: 'answer' }, usage: { inputTokens: 1 } },
  });
});

test('R62 streaming requests are captured at invocation, before the caller can mutate them', async () => {
  let finish!: (result: ModelResult) => void;
  const stream = (): Promise<ModelResult> =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const recorder = recordingModel({ generate: stream, stream });
  const req = { messages: [{ role: 'user' as const, content: 'original' }] };
  const pending = recorder.stream!(req, () => {});
  req.messages[0]!.content = 'changed in flight';
  finish({ message: { role: 'assistant', content: 'recorded' } });
  await pending;
  const replay = replayModel(recorder.recording(), { strict: true });
  expect(
    (await replay.generate({ messages: [{ role: 'user', content: 'original' }] })).message.content,
  ).toBe('recorded');
});

test('R49 replay stream checks cancellation before consuming and between chunks', async () => {
  const recorder = recordingModel(scriptedModel([{ role: 'assistant', content: 'abcdefgh' }]));
  await recorder.stream!({ messages: [] }, () => {});
  const replay = replayModel(recorder.recording());
  const stop = new AbortController();
  stop.abort(new Error('stop before'));
  await expect(replay.stream!({ messages: [], signal: stop.signal }, () => {})).rejects.toThrow(
    'stop before',
  );
  const mid = new AbortController();
  let chunks = 0;
  await expect(
    replay.stream!({ messages: [], signal: mid.signal }, () => {
      chunks++;
      mid.abort(new Error('stop during'));
    }),
  ).rejects.toThrow('stop during');
  expect(chunks).toBe(1);
});
