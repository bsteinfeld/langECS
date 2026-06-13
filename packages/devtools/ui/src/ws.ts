// WebSocket client for the devtools server. Auto-reconnects with capped
// exponential backoff + jitter, and provides a request/response helper over
// the command/result protocol (incrementing ids, 10s timeout).

import type { ClientCommand, ServerMessage } from '../../src/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** A `ClientCommand` without the wire `id` — `request()` assigns one. */
export type CommandInput = {
  [K in ClientCommand['type']]: Omit<Extract<ClientCommand, { type: K }>, 'id'>;
}[ClientCommand['type']];

export interface DevtoolsSocket {
  /** Send a command; resolves with `result.data`, rejects on `ok:false` or timeout. */
  request(cmd: CommandInput): Promise<unknown>;
  close(): void;
}

interface PendingRequest {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;

export function connectDevtools(handlers: {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
}): DevtoolsSocket {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const pending = new Map<number, PendingRequest>();
  let ws: WebSocket | null = null;
  let nextId = 1;
  let attempts = 0;
  let closed = false;
  let reconnectTimer: number | undefined;

  const failAll = (reason: string): void => {
    for (const req of pending.values()) {
      window.clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    pending.clear();
  };

  const open = (): void => {
    if (closed) return;
    handlers.onStatus('connecting');
    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      attempts = 0;
      handlers.onStatus('open');
    };

    sock.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'result') {
        const req = pending.get(msg.id);
        if (req) {
          pending.delete(msg.id);
          window.clearTimeout(req.timer);
          if (msg.ok) req.resolve(msg.data);
          else req.reject(new Error(msg.error));
        }
        return;
      }
      handlers.onMessage(msg);
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      failAll('Connection closed');
      handlers.onStatus('closed');
      if (closed) return;
      attempts += 1;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 5));
      reconnectTimer = window.setTimeout(open, backoff + Math.random() * 300);
    };

    sock.onerror = () => {
      sock.close();
    };
  };

  open();

  return {
    request(cmd: CommandInput): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const sock = ws;
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          reject(new Error('Not connected to the devtools server'));
          return;
        }
        const id = nextId++;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error('Command timed out after 10s'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        sock.send(JSON.stringify({ id, ...cmd }));
      });
    },
    close(): void {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      failAll('Socket closed');
      ws?.close();
    },
  };
}
