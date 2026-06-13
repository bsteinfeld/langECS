// Entry point: owns the WebSocket lifecycle and the reducer store, batching
// server messages per animation frame so run-event bursts cost one render.

import { StrictMode, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ServerMessage } from '../../src/protocol';
import { App } from './App';
import { errorMessage } from './format';
import { type CommandResult, initialState, reducer, StoreContext, type StoreValue } from './store';
import './styles.css';
import { type CommandInput, connectDevtools, type DevtoolsSocket } from './ws';

function DevtoolsRoot() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<DevtoolsSocket | null>(null);

  useEffect(() => {
    const buffer: ServerMessage[] = [];
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = null;
      timer = null;
      if (buffer.length > 0) dispatch({ type: 'server', messages: buffer.splice(0) });
    };
    const socket = connectDevtools({
      onMessage(msg) {
        buffer.push(msg);
        // rAF batches bursts to one render — but it never fires in a hidden
        // tab, so a timer backstop keeps long runs from buffering a full
        // WorldState per step unboundedly while the inspector is backgrounded.
        if (frame === null && timer === null) {
          frame = requestAnimationFrame(flush);
          timer = setTimeout(flush, 250);
        } else if (buffer.length >= 500) {
          flush();
        }
      },
      onStatus(status) {
        dispatch({ type: 'status', status });
        // Re-sync after a reconnect — the server re-pushes world + trace.
        if (status === 'open') void socket.request({ type: 'refresh' }).catch(() => {});
      },
    });
    socketRef.current = socket;
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const command = useCallback(async (cmd: CommandInput): Promise<CommandResult> => {
    const socket = socketRef.current;
    try {
      if (!socket) throw new Error('Not connected to the devtools server');
      const data = await socket.request(cmd);
      return { ok: true, data };
    } catch (err) {
      const error = errorMessage(err);
      dispatch({ type: 'toast', kind: 'error', text: error });
      return { ok: false, error };
    }
  }, []);

  const value = useMemo<StoreValue>(() => ({ state, dispatch, command }), [state, command]);

  return (
    <StoreContext.Provider value={value}>
      <App />
    </StoreContext.Provider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');
createRoot(container).render(
  <StrictMode>
    <DevtoolsRoot />
  </StrictMode>,
);
