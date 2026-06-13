// startDevtools — real node:http + 'ws' clients on ephemeral ports (port: 0).
// Zero network beyond 127.0.0.1; no sleeps — everything waits on messages.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  interrupt,
  MemoryAdapter,
  type World,
} from '@langecs/core';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientCommand, ServerMessage } from '../src/protocol';
import { type DevtoolsOptions, type DevtoolsServer, startDevtools } from '../src/server';

// Component names share one global registry per vitest process — prefix.
const Doc = defineComponent<string>({ name: 'dtsrvDoc' });
const Done = defineTag('dtsrvDone');

const finishSys = defineSystem({
  name: 'dtsrvFinish',
  query: [Doc],
  run: (e) => {
    e.add(Done);
  },
});

type WorldMsg = Extract<ServerMessage, { type: 'world' }>;
type ResultMsg = Extract<ServerMessage, { type: 'result' }>;
type SpansMsg = Extract<ServerMessage, { type: 'spans' }>;

class TestClient {
  readonly messages: ServerMessage[] = [];
  private notifiers: (() => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
      for (const notify of this.notifiers.splice(0)) notify();
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  async waitUntil(cond: () => boolean, what = 'condition'): Promise<void> {
    const deadline = Date.now() + 4000;
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.messages)}`);
      }
      await Promise.race([
        new Promise<void>((notify) => this.notifiers.push(notify)),
        new Promise<void>((tick) => setTimeout(tick, 250)),
      ]);
    }
  }

  /** Waits for a message matching `pred`, scanning only indexes >= `from`. */
  async waitFor(
    pred: (m: ServerMessage) => boolean,
    what = 'message',
    from = 0,
  ): Promise<ServerMessage> {
    const match = (m: ServerMessage, i: number): boolean => i >= from && pred(m);
    await this.waitUntil(() => this.messages.some(match), what);
    const found = this.messages.find(match);
    if (!found) throw new Error(`message vanished: ${what}`);
    return found;
  }

  /** Cursor for `waitFor`'s `from` — "only messages after this point". */
  mark(): number {
    return this.messages.length;
  }

  async command(cmd: ClientCommand): Promise<ResultMsg> {
    this.ws.send(JSON.stringify(cmd));
    return (await this.waitFor(
      (m) => m.type === 'result' && m.id === cmd.id,
      `result ${cmd.id}`,
    )) as ResultMsg;
  }

  runEnds(): number {
    return this.messages.filter((m) => m.type === 'run-event' && m.event.type === 'run:end').length;
  }

  close(): void {
    this.ws.close();
  }
}

const servers: DevtoolsServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function start(world: World, opts?: DevtoolsOptions): Promise<DevtoolsServer> {
  const server = await startDevtools(world, { port: 0, ...opts });
  servers.push(server);
  return server;
}

async function connect(server: DevtoolsServer): Promise<TestClient> {
  const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
  clients.push(client);
  return client;
}

test('connect: hello, world, trace in order; ephemeral port reported', async () => {
  const world = createWorld({ id: 'dtsrv-hello' });
  const e = world.spawn(Doc('hi'));
  const server = await start(world);
  expect(server.port).toBeGreaterThan(0);
  expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

  const client = await connect(server);
  await client.waitFor((m) => m.type === 'trace', 'trace');
  expect(client.messages[0]).toEqual({ type: 'hello', protocol: 1, worldId: 'dtsrv-hello' });
  const world1 = client.messages[1] as WorldMsg;
  expect(world1.type).toBe('world');
  expect(world1.state.worldId).toBe('dtsrv-hello');
  expect(world1.state.running).toBe(false);
  expect(world1.state.historySteps).toBeNull(); // no history adapter wired
  expect(world1.state.entities.map((ent) => ent.id)).toEqual([e.id]);
  expect(client.messages[2]?.type).toBe('trace');
  // Empty span buffer → no spans replay.
  expect(client.messages.some((m) => m.type === 'spans')).toBe(false);
});

test('mutate roundtrip: ok result, then a world push with the new value', async () => {
  const world = createWorld({ id: 'dtsrv-mutate' });
  const e = world.spawn(Doc('old'));
  const server = await start(world);
  const client = await connect(server);

  const res = await client.command({
    id: 1,
    type: 'mutate',
    entity: e.id,
    component: 'dtsrvDoc',
    action: 'set',
    value: 'new',
  });
  expect(res).toEqual({ type: 'result', id: 1, ok: true });
  await client.waitFor(
    (m) =>
      m.type === 'world' &&
      m.state.entities.some((ent) =>
        ent.components.some((c) => c.name === 'dtsrvDoc' && c.value === 'new'),
      ),
    'world with new value',
  );
  expect(e.get(Doc)).toBe('new');
});

test('mutate with unknown component / unknown entity fails', async () => {
  const world = createWorld({ id: 'dtsrv-badmutate' });
  const e = world.spawn(Doc('x'));
  const server = await start(world);
  const client = await connect(server);

  const badComponent = await client.command({
    id: 1,
    type: 'mutate',
    entity: e.id,
    component: 'dtsrvNope',
    action: 'set',
    value: 1,
  });
  expect(badComponent).toMatchObject({
    ok: false,
    error: expect.stringContaining('Unknown component "dtsrvNope"'),
  });

  const badEntity = await client.command({
    id: 2,
    type: 'mutate',
    entity: 999,
    component: 'dtsrvDoc',
    action: 'set',
    value: 1,
  });
  expect(badEntity).toMatchObject({ ok: false, error: expect.stringContaining('Unknown entity') });
});

test('spawn and despawn commands', async () => {
  const world = createWorld({ id: 'dtsrv-spawn' });
  const server = await start(world);
  const client = await connect(server);

  const spawned = await client.command({
    id: 1,
    type: 'spawn',
    components: [
      { name: 'dtsrvDoc', value: 'born' },
      { name: 'dtsrvDone', value: undefined }, // tag — value omitted on the wire
    ],
  });
  expect(spawned).toMatchObject({ ok: true, data: { entity: 1 } });
  const handle = world.entity(1);
  expect(handle?.get(Doc)).toBe('born');
  expect(handle?.has(Done)).toBe(true);

  const unknown = await client.command({
    id: 2,
    type: 'spawn',
    components: [{ name: 'dtsrvNope', value: 1 }],
  });
  expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('Unknown component') });

  const mark = client.mark();
  const despawned = await client.command({ id: 3, type: 'despawn', entity: 1 });
  expect(despawned).toMatchObject({ ok: true });
  expect(world.entity(1)).toBeUndefined();
  // From `mark`: the initial connect-time world was also empty.
  await client.waitFor(
    (m) => m.type === 'world' && m.state.entities.length === 0,
    'world without despawned entity',
    mark,
  );
});

test('run command: ok immediately, run-event stream incl. run:end, world updates', async () => {
  const world = createWorld({ id: 'dtsrv-run' });
  world.use(finishSys);
  const e = world.spawn(Doc('go'));
  const server = await start(world);
  const client = await connect(server);

  const res = await client.command({ id: 1, type: 'run' });
  expect(res).toEqual({ type: 'result', id: 1, ok: true });
  await client.waitUntil(() => client.runEnds() === 1, 'run:end');

  const eventTypes = client.messages
    .filter((m) => m.type === 'run-event')
    .map((m) => (m as Extract<ServerMessage, { type: 'run-event' }>).event.type);
  expect(eventTypes).toEqual([
    'run:start',
    'step:start',
    'system:start',
    'system:end',
    'step:applied',
    'run:end',
  ]);
  await client.waitFor(
    (m) =>
      m.type === 'world' &&
      m.state.step === 1 &&
      m.state.entities.some(
        (ent) => ent.id === e.id && ent.components.some((c) => c.name === 'dtsrvDone'),
      ),
    'world with Done',
  );
  // step:applied also pushed a fresh trace buffer.
  await client.waitFor(
    (m) => m.type === 'trace' && m.steps.length === 1 && m.steps[0]?.step === 1,
    'trace with step 1',
  );
});

test('mutate while running fails with the WorldRunningError message', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const blocker = defineSystem({
    name: 'dtsrvBlocker',
    query: [Doc],
    run: async () => {
      await gate;
    },
  });
  const world = createWorld({ id: 'dtsrv-blocking' });
  world.use(blocker);
  const e = world.spawn(Doc('held'));
  const server = await start(world);
  const client = await connect(server);

  const runRes = await client.command({ id: 1, type: 'run' });
  expect(runRes).toMatchObject({ ok: true });
  await client.waitFor(
    (m) => m.type === 'run-event' && m.event.type === 'system:start',
    'system:start',
  );

  const mutRes = await client.command({
    id: 2,
    type: 'mutate',
    entity: e.id,
    component: 'dtsrvDoc',
    action: 'set',
    value: 'nope',
  });
  expect(mutRes).toMatchObject({
    ok: false,
    error: expect.stringContaining('while a run is in flight'),
  });
  // A second run while one is in flight is also a clean failure, not a crash.
  const runAgain = await client.command({ id: 3, type: 'run' });
  expect(runAgain).toMatchObject({
    ok: false,
    error: expect.stringContaining('while a run is in flight'),
  });

  release();
  await client.waitUntil(() => client.runEnds() === 1, 'run:end after release');
  expect(e.get(Doc)).toBe('held'); // rejected mutation never landed
});

test('resume flow: interrupt answered, run fires, interrupts clear', async () => {
  const world = createWorld({ id: 'dtsrv-resume' });
  const e = world.spawn(interrupt('approval', { tool: 'rmrf' }, 'dtsrv-int-1'));
  const server = await start(world);
  const client = await connect(server);

  const first = (await client.waitFor((m) => m.type === 'world', 'first world')) as WorldMsg;
  expect(first.state.interrupts).toEqual([
    {
      entity: e.id,
      interrupts: [{ id: 'dtsrv-int-1', kind: 'approval', payload: { tool: 'rmrf' } }],
    },
  ]);

  const res = await client.command({ id: 1, type: 'resume', entity: e.id, value: { ok: true } });
  expect(res).toMatchObject({ ok: true });
  await client.waitUntil(() => client.runEnds() === 1, 'run:end');
  await client.waitFor(
    (m) =>
      m.type === 'world' &&
      m.state.interrupts.length === 0 &&
      m.state.entities.some((ent) =>
        ent.components.some(
          (c) => c.name === 'HumanResponse' && JSON.stringify(c.value) === '{"value":{"ok":true}}',
        ),
      ),
    'world with HumanResponse and no interrupts',
  );
  expect(world.pending()).toEqual([]);
});

test('send command adds components then runs', async () => {
  const world = createWorld({ id: 'dtsrv-send' });
  world.use(finishSys);
  const e = world.spawn(); // empty entity
  const server = await start(world);
  const client = await connect(server);

  const res = await client.command({
    id: 1,
    type: 'send',
    entity: e.id,
    components: [{ name: 'dtsrvDoc', value: 'input' }],
  });
  expect(res).toMatchObject({ ok: true });
  await client.waitUntil(() => client.runEnds() === 1, 'run:end');
  expect(e.get(Doc)).toBe('input');
  expect(e.has(Done)).toBe(true);
});

test('snapshot command returns a Snapshot', async () => {
  const world = createWorld({ id: 'dtsrv-snapshot' });
  const e = world.spawn(Doc('snap'));
  const server = await start(world);
  const client = await connect(server);

  const res = await client.command({ id: 1, type: 'snapshot' });
  expect(res.ok).toBe(true);
  expect((res as { data?: unknown }).data).toMatchObject({
    version: 1,
    worldId: 'dtsrv-snapshot',
    step: 0,
    entities: [{ id: e.id, components: { dtsrvDoc: 'snap' } }],
  });
});

test('refresh re-pushes world and trace to the requesting client only', async () => {
  const world = createWorld({ id: 'dtsrv-refresh' });
  world.spawn(Doc('r'));
  const server = await start(world);
  const client = await connect(server);
  const other = await connect(server);
  await client.waitFor((m) => m.type === 'trace', 'initial trace');
  await other.waitFor((m) => m.type === 'trace', 'initial trace (other)');
  const otherCount = other.messages.length;

  const res = await client.command({ id: 7, type: 'refresh' });
  expect(res).toMatchObject({ ok: true });
  expect(client.messages.filter((m) => m.type === 'world').length).toBe(2);
  expect(client.messages.filter((m) => m.type === 'trace').length).toBe(2);
  expect(other.messages.length).toBe(otherCount);
});

const otlpFixture = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'dtsrv-app' } }] },
      scopeSpans: [
        {
          scope: { name: 'dtsrv-scope' },
          spans: [
            {
              traceId: 'a'.repeat(32),
              spanId: 'b'.repeat(16),
              name: 'demo-span',
              kind: 'SPAN_KIND_INTERNAL',
              startTimeUnixNano: '1',
              endTimeUnixNano: '2',
              attributes: [{ key: 'n', value: { intValue: '5' } }],
            },
          ],
        },
      ],
    },
  ],
};

test('OTLP POST: spans broadcast live and replayed to new clients', async () => {
  const world = createWorld({ id: 'dtsrv-otlp' });
  const server = await start(world);
  const client = await connect(server);
  await client.waitFor((m) => m.type === 'trace', 'initial trace');

  const res = await fetch(`${server.url}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(otlpFixture),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(await res.json()).toEqual({ partialSuccess: {} });

  const live = (await client.waitFor((m) => m.type === 'spans', 'live spans')) as SpansMsg;
  expect(live.spans).toHaveLength(1);
  expect(live.spans[0]).toMatchObject({
    traceId: 'a'.repeat(32),
    name: 'demo-span',
    kind: 1,
    attributes: { n: 5 },
    resource: { 'service.name': 'dtsrv-app' },
  });

  // Ring buffer replays to a NEW client on connect.
  const late = await connect(server);
  const replay = (await late.waitFor((m) => m.type === 'spans', 'replayed spans')) as SpansMsg;
  expect(replay.spans).toEqual(live.spans);
});

test('OTLP preflight is allowed; protobuf content type gets a helpful 415', async () => {
  const world = createWorld({ id: 'dtsrv-415' });
  const server = await start(world);

  const preflight = await fetch(`${server.url}/v1/traces`, { method: 'OPTIONS' });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

  const res = await fetch(`${server.url}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(415);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain('@opentelemetry/exporter-trace-otlp-http');
});

test('history steps refresh after runs; load-step time travel', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'dtsrv-history', persistence: adapter });
  world.use(finishSys);
  const e = world.spawn(Doc('v1'));
  const server = await start(world, { history: adapter });
  const client = await connect(server);

  const first = (await client.waitFor((m) => m.type === 'world', 'first world')) as WorldMsg;
  expect(first.state.historySteps).toEqual([]); // adapter wired, nothing saved yet

  await client.command({ id: 1, type: 'run' });
  await client.waitUntil(() => client.runEnds() === 1, 'first run:end');
  await client.waitFor(
    (m) => m.type === 'world' && JSON.stringify(m.state.historySteps) === '[1]',
    'historySteps [1]',
  );

  await client.command({
    id: 2,
    type: 'mutate',
    entity: e.id,
    component: 'dtsrvDoc',
    action: 'set',
    value: 'v2',
  });
  await client.command({ id: 3, type: 'run' });
  await client.waitUntil(() => client.runEnds() === 2, 'second run:end');
  await client.waitFor(
    (m) => m.type === 'world' && JSON.stringify(m.state.historySteps) === '[1,2]',
    'historySteps [1,2]',
  );
  expect(world.step).toBe(2);

  const missing = await client.command({ id: 4, type: 'load-step', step: 99 });
  expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('step 99') });

  const mark = client.mark();
  const loaded = await client.command({ id: 5, type: 'load-step', step: 1 });
  expect(loaded).toMatchObject({ ok: true });
  expect(world.step).toBe(1);
  // The step-1 snapshot predates the external 'v2' mutation (saves happen at
  // barriers/run-end only), so time travel restores 'v1'.
  expect(world.entity(e.id)?.get(Doc)).toBe('v1');
  await client.waitFor(
    (m) =>
      m.type === 'world' &&
      m.state.step === 1 &&
      m.state.entities.some((ent) =>
        ent.components.some((c) => c.name === 'dtsrvDoc' && c.value === 'v1'),
      ),
    'world back at step 1',
    mark,
  );
});

test('load-step without a history adapter is a clean error', async () => {
  const world = createWorld({ id: 'dtsrv-nohist' });
  const server = await start(world);
  const client = await connect(server);
  const res = await client.command({ id: 1, type: 'load-step', step: 1 });
  expect(res).toMatchObject({ ok: false, error: expect.stringContaining('history adapter') });
});

test('EADDRINUSE walks to a nearby free port', async () => {
  const w1 = createWorld({ id: 'dtsrv-p1' });
  const w2 = createWorld({ id: 'dtsrv-p2' });
  const s1 = await start(w1);
  const s2 = await start(w2, { port: s1.port });
  expect(s2.port).not.toBe(s1.port);
  expect(s2.port).toBeGreaterThan(s1.port);
  expect(s2.port).toBeLessThanOrEqual(s1.port + 20);
});

test('static hosting: SPA fallback, placeholder when the UI is not built', async () => {
  const world = createWorld({ id: 'dtsrv-static' });
  const server = await start(world);

  const root = await fetch(`${server.url}/`);
  expect(root.status).toBe(200);
  expect(root.headers.get('content-type')).toContain('text/html');
  const rootText = await root.text();

  // Unknown deep link → same document (SPA fallback / placeholder).
  const deep = await fetch(`${server.url}/entities/42`);
  expect(deep.status).toBe(200);
  expect(await deep.text()).toBe(rootText);

  const uiIndex = fileURLToPath(new URL('../dist/ui/index.html', import.meta.url));
  if (!existsSync(uiIndex)) {
    expect(rootText).toContain('pnpm -C packages/devtools build');
  }
});

test('WS upgrade rejects cross-site origins, allows loopback and absent Origin', async () => {
  const world = createWorld({ id: 'dtsrv-origin' });
  const server = await start(world);

  // A browser on any non-local website carries its Origin — must be refused
  // (Cross-Site WebSocket Hijacking would otherwise control the world).
  const rejected = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { origin: 'https://evil.example' },
    });
    ws.once('open', () => {
      ws.close();
      resolve(false);
    });
    ws.once('error', () => resolve(true));
  });
  expect(rejected).toBe(true);

  // The inspector itself (same host) and the Vite dev proxy (localhost:5173)
  // are loopback origins — allowed.
  const viaLoopback = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { origin: 'http://localhost:5173' },
    });
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
  expect(viaLoopback).toBe(true);

  // No Origin header (tests, CLIs, server-side clients) keeps working — the
  // suite's own TestClient connections already prove this, but be explicit.
  const client = await connect(server);
  await client.waitFor((m) => m.type === 'hello', 'hello');
});

test('world push at step:applied reports the step the state belongs to', async () => {
  // Core emits step:applied BEFORE incrementing world.step (SPEC §5), so the
  // server must stamp the broadcast with the event's own step number.
  const world = createWorld({ id: 'dtsrv-stepno' });
  world.use(finishSys);
  world.spawn(Doc('go'));
  const server = await start(world);
  const client = await connect(server);
  await client.waitFor((m) => m.type === 'trace', 'initial trace');

  const from = client.mark();
  const result = await client.command({ id: 91, type: 'run' });
  expect(result.ok).toBe(true);
  await client.waitFor(
    (m) => m.type === 'run-event' && m.event.type === 'run:end',
    'run:end',
    from,
  );

  const idx = client.messages.findIndex(
    (m, i) => i >= from && m.type === 'run-event' && m.event.type === 'step:applied',
  );
  expect(idx).toBeGreaterThan(-1);
  const applied = client.messages[idx] as Extract<ServerMessage, { type: 'run-event' }>;
  const appliedStep = applied.event.type === 'step:applied' ? applied.event.step : -1;
  const worldAfter = client.messages.slice(idx).find((m) => m.type === 'world') as WorldMsg;
  expect(worldAfter.state.step).toBe(appliedStep);

  // run:start flips `running` immediately for every client (the first barrier
  // may be a slow model call away).
  const runStartIdx = client.messages.findIndex(
    (m, i) => i >= from && m.type === 'run-event' && m.event.type === 'run:start',
  );
  const worldAtStart = client.messages.slice(runStartIdx, idx).find((m) => m.type === 'world') as
    | WorldMsg
    | undefined;
  expect(worldAtStart?.state.running).toBe(true);
});
