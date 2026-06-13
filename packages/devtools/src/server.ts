// The devtools server: one HTTP server hosting the built inspector UI, an
// OTLP/HTTP JSON trace receiver on `POST /v1/traces`, and a `/ws` WebSocket
// speaking the protocol in `./protocol`. Wired to a live world through
// `world.observe(...)` (SPEC §14, R45/R48) — strictly a passive consumer; all
// mutations go through the same external APIs any caller would use (R16).

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ComponentInit,
  getComponentByName,
  type PersistenceAdapter,
  type Run,
  type World,
} from '@langecs/core';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeOtlpTraces } from './otlp';
import {
  type ClientCommand,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SpanRecord,
} from './protocol';
import { buildWorldState } from './state';

export interface DevtoolsOptions {
  /** Base port; on EADDRINUSE the next 20 ports are tried. Default 4477. */
  port?: number;
  /** Default '127.0.0.1' — bind to a non-loopback host deliberately. */
  host?: string;
  /** Persistence adapter for the history strip + `load-step` time travel. */
  history?: PersistenceAdapter;
  /** OTLP span ring-buffer capacity (oldest dropped). Default 5000. */
  spanBufferSize?: number;
  /** Open the inspector in the default browser after listening. */
  open?: boolean;
}

export interface DevtoolsServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

// Resolves to <package>/dist/ui from BOTH entry layouts: running the source
// via tsx (`<pkg>/src/server.ts` → `../dist/ui` → `<pkg>/dist/ui`) and the
// built bundle (`<pkg>/dist/index.js` → `../dist/ui` → `<pkg>/dist/ui`).
const uiDir = fileURLToPath(new URL('../dist/ui', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LangECS devtools</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>LangECS devtools</h1>
<p>The inspector UI has not been built yet. Build it with:</p>
<pre><code>pnpm -C packages/devtools build</code></pre>
<p>The server itself is running — <code>/ws</code> and <code>POST /v1/traces</code> are live.</p>
</body>
</html>
`;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const report = (...args: unknown[]): void => {
  console.error('[langecs-devtools]', ...args);
};

/** OTLP/JSON batches are typically well under 4 MB; cap far above that. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering a hostile/runaway payload — OOM is not an option.
        req.destroy();
        rejectBody(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/**
 * Cross-Site-WebSocket-Hijacking guard: browsers send an Origin header on WS
 * upgrades and enforce no cross-origin rules of their own, so without this
 * check ANY website open in a local browser could connect to the loopback
 * inspector and read/mutate the world. Allowed: no Origin (non-browser
 * clients — tests, CLIs), loopback origins on any port (covers the Vite dev
 * proxy on :5173), and origins whose hostname is the deliberately-bound host.
 */
function originAllowed(origin: string | undefined, boundHost: string): boolean {
  if (origin === undefined) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return loopback || hostname === boundHost;
}

/**
 * Listens on `basePort`; on EADDRINUSE walks up to `basePort + 20` (devs run
 * several worlds side by side). Port 0 is honored as "OS-assigned" — the
 * resolved value is always the actual bound port.
 */
function listenWithRetry(server: Server, host: string, basePort: number): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && basePort !== 0 && attempt < 20) {
          attempt += 1;
          tryListen(basePort + attempt);
        } else {
          rejectPort(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolvePort(addr !== null && typeof addr === 'object' ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryListen(basePort);
  });
}

function setCors(res: ServerResponse): void {
  // Permissive CORS on /v1/* so browser apps can export OTLP straight here.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (decoded === '/') decoded = '/index.html';
  // Sanitize: resolve against the UI root and require the result to stay
  // inside it — `..` segments and absolute tricks land outside and get 403.
  const filePath = resolve(uiDir, `.${decoded}`);
  if (filePath !== uiDir && !filePath.startsWith(uiDir + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(data);
    return;
  } catch {
    // Missing file → SPA fallback below.
  }
  try {
    const index = await readFile(resolve(uiDir, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(index);
  } catch {
    // UI never built — explain instead of 404ing the whole inspector.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PLACEHOLDER_HTML);
  }
}

export async function startDevtools(
  world: World,
  options?: DevtoolsOptions,
): Promise<DevtoolsServer> {
  const host = options?.host ?? '127.0.0.1';
  const basePort = options?.port ?? 4477;
  const spanBufferSize = options?.spanBufferSize ?? 5000;
  const history = options?.history;

  const spanBuffer: SpanRecord[] = [];
  // `null` (and stays null) when no history adapter is wired — the UI hides
  // the time-travel strip entirely in that case.
  let historySteps: number[] | null = typeof history?.history === 'function' ? [] : null;
  let closed = false;

  // `stepOverride`: at a step:applied broadcast the engine has not yet
  // incremented `world.step` (SPEC §5 emits step:applied BEFORE world.step++),
  // so the event's own step number is the truthful one for the state shown.
  const worldMessage = (stepOverride?: number): ServerMessage => {
    const state = buildWorldState(world, historySteps);
    if (stepOverride !== undefined) state.step = stepOverride;
    return { type: 'world', state };
  };
  const traceMessage = (): ServerMessage => ({ type: 'trace', steps: world.getTrace() });

  const httpServer = createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      report('http handler failed:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin, host),
  });
  // ws forwards the underlying http server's 'error' events to the
  // WebSocketServer; without a listener that re-emit throws (unhandled
  // 'error') INSIDE the http server's emit, aborting dispatch before the
  // EADDRINUSE retry handler in listenWithRetry ever runs. EADDRINUSE is
  // handled there; anything else is only worth a report.
  wss.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') report('ws server error:', err);
  });

  const send = (client: WebSocket, message: ServerMessage): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(JSON.stringify(message));
    } catch (err) {
      report('failed to send ws message:', err);
    }
  };

  const broadcast = (message: ServerMessage): void => {
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      report('failed to serialize broadcast:', err);
      return;
    }
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(payload);
      } catch (err) {
        // One torn socket must not starve the remaining clients (or abort the
        // observer callback this broadcast runs inside).
        report('failed to send ws message:', err);
      }
    }
  };

  // ----------------------------------------------------------- history steps

  const sameSteps = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((step, i) => step === b[i]);

  /** Re-reads the adapter's history; broadcasts `world` when the list moved. */
  const refreshHistory = async (): Promise<void> => {
    if (!history?.history) return;
    try {
      const entries = await history.history(world.id);
      const steps = entries.map((entry) => entry.step);
      if (historySteps !== null && sameSteps(historySteps, steps)) return;
      historySteps = steps;
      if (!closed) broadcast(worldMessage());
    } catch (err) {
      report('history refresh failed:', err);
    }
  };

  // -------------------------------------------------------- observer wiring

  // External changes arrive one notification per mutation (R48); a microtask
  // debounce folds e.g. a multi-component spawn into one `world` push.
  let externalFlushScheduled = false;
  const scheduleExternalBroadcast = (): void => {
    if (externalFlushScheduled) return;
    externalFlushScheduled = true;
    queueMicrotask(() => {
      externalFlushScheduled = false;
      if (!closed) broadcast(worldMessage());
    });
  };

  const detachObserver = world.observe({
    onEvent: (event, info) => {
      broadcast({ type: 'run-event', runId: info.runId, event });
      if (event.type === 'run:start') {
        // Flip `running` for every client immediately — the first barrier can
        // be a slow model call away, and stale running=false would leave Run/
        // Send/Resume enabled only to bounce off R16.
        broadcast(worldMessage());
      } else if (event.type === 'step:applied') {
        // Synchronous on purpose: at the barrier boundary committed state is
        // consistent (R25), so state + trace built here match this step.
        broadcast(worldMessage(event.step));
        broadcast(traceMessage());
      } else if (event.type === 'run:end' || event.type === 'run:reject') {
        broadcast(worldMessage());
        void refreshHistory();
      }
    },
    onExternalChange: () => scheduleExternalBroadcast(),
  });

  // -------------------------------------------------------------- commands

  const buildInits = (specs: { name: string; value: unknown }[]): ComponentInit<any>[] =>
    specs.map((spec) => {
      const component = getComponentByName(spec.name);
      if (!component) throw new Error(`Unknown component "${spec.name}".`);
      return component(spec.value);
    });

  const requireEntity = (id: number) => {
    const handle = world.entity(id);
    if (!handle) throw new Error(`Unknown entity ${id}.`);
    return handle;
  };

  // Runs are fired, never awaited, inside the message handler: events stream
  // to clients via the observer tap, and a barrier rejection (e.g.
  // WriteConflictError) reaches them as `run:reject` — the guard below only
  // keeps the rejection from becoming an unhandled-rejection crash.
  const fireRun = (run: Run): void => {
    void run.then(undefined, () => {});
  };

  async function handleCommand(client: WebSocket, cmd: ClientCommand): Promise<void> {
    const ok = (data?: unknown): void => {
      send(
        client,
        data === undefined
          ? { type: 'result', id: cmd.id, ok: true }
          : { type: 'result', id: cmd.id, ok: true, data },
      );
    };
    try {
      switch (cmd.type) {
        case 'refresh': {
          send(client, worldMessage());
          send(client, traceMessage());
          ok();
          break;
        }
        case 'mutate': {
          const handle = requireEntity(cmd.entity);
          const component = getComponentByName(cmd.component);
          if (!component) throw new Error(`Unknown component "${cmd.component}".`);
          // `add`/`set` with an undefined value store `true` (tag semantics),
          // matching the engine's own external-handle default.
          if (cmd.action === 'remove') handle.remove(component);
          else if (cmd.action === 'add') handle.add(component, cmd.value);
          else handle.set(component, cmd.value);
          ok();
          break;
        }
        case 'spawn': {
          const handle = world.spawn(...buildInits(cmd.components));
          ok({ entity: handle.id });
          break;
        }
        case 'despawn': {
          requireEntity(cmd.entity).despawn();
          ok();
          break;
        }
        case 'run': {
          fireRun(world.run());
          ok();
          break;
        }
        case 'send': {
          fireRun(world.send(cmd.entity, ...buildInits(cmd.components)));
          ok();
          break;
        }
        case 'resume': {
          fireRun(world.resume(cmd.entity, cmd.value));
          ok();
          break;
        }
        case 'snapshot': {
          ok(world.snapshot());
          break;
        }
        case 'load-step': {
          if (!history?.loadStep) {
            throw new Error(
              'Time travel requires a history adapter with loadStep() — pass one via startDevtools(world, { history }).',
            );
          }
          const snap = await history.loadStep(world.id, cmd.step);
          if (snap === null) throw new Error(`No snapshot recorded for step ${cmd.step}.`);
          world.load(snap); // engine enforces idle (R16) and validates (R36)
          ok();
          await refreshHistory();
          break;
        }
        default: {
          throw new Error(`Unknown command type "${(cmd as { type?: string }).type}".`);
        }
      }
    } catch (err) {
      send(client, { type: 'result', id: cmd.id, ok: false, error: errorMessage(err) });
    }
  }

  wss.on('connection', (client) => {
    send(client, { type: 'hello', protocol: PROTOCOL_VERSION, worldId: world.id });
    send(client, worldMessage());
    send(client, traceMessage());
    if (spanBuffer.length > 0) send(client, { type: 'spans', spans: [...spanBuffer] });
    client.on('message', (data) => {
      let cmd: unknown;
      try {
        cmd = JSON.parse(String(data));
      } catch {
        return; // not JSON — no id to answer
      }
      if (typeof cmd !== 'object' || cmd === null) return;
      if (typeof (cmd as { id?: unknown }).id !== 'number') return;
      handleCommand(client, cmd as ClientCommand).catch((err) => {
        report('command handler failed:', err);
      });
    });
    client.on('error', (err) => report('ws client error:', err));
  });

  // ------------------------------------------------------------------- http

  async function handleTraces(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('json')) {
      sendJson(res, 415, {
        error:
          `Unsupported content type "${contentType}". This endpoint accepts OTLP/HTTP JSON only — ` +
          'configure the http/json exporter (@opentelemetry/exporter-trace-otlp-http), not the protobuf one.',
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: err.message });
      } else {
        sendJson(res, 400, { error: 'Invalid JSON body.' });
      }
      return;
    }
    const spans = decodeOtlpTraces(parsed);
    if (spans.length > 0) {
      spanBuffer.push(...spans);
      if (spanBuffer.length > spanBufferSize) {
        spanBuffer.splice(0, spanBuffer.length - spanBufferSize);
      }
      broadcast({ type: 'spans', spans });
    }
    sendJson(res, 200, { partialSuccess: {} });
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/v1/')) {
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/traces') {
        await handleTraces(req, res);
        return;
      }
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    await serveStatic(url.pathname, res);
  }

  // ----------------------------------------------------------------- listen

  const port = await listenWithRetry(httpServer, host, basePort);
  const url = `http://${host}:${port}`;

  await refreshHistory();

  if (options?.open) {
    try {
      const { exec } = await import('node:child_process');
      const opener =
        process.platform === 'darwin'
          ? `open "${url}"`
          : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
      exec(opener, () => {
        // Opener failures (headless CI, no browser) are non-fatal.
      });
    } catch {
      // dynamic import failed — ignore, the URL is in the return value.
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    detachObserver();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((done) => {
      wss.close(() => done());
    });
    await new Promise<void>((done) => {
      httpServer.close(() => done());
    });
  };

  return { url, port, close };
}
