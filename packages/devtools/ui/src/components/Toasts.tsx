// Bottom-right toast stack. Every command rejection lands here (see the
// provider's `command` helper); toasts auto-dismiss after a few seconds.

import { useEffect } from 'react';
import { type Toast, useStore } from '../store';
import { CloseIcon } from './icons';

const TOAST_TTL_MS = 5000;

function ToastRow({ toast }: { toast: Toast }) {
  const { dispatch } = useStore();
  useEffect(() => {
    const timer = window.setTimeout(
      () => dispatch({ type: 'dismiss-toast', id: toast.id }),
      TOAST_TTL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast.id, dispatch]);
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss notification"
        onClick={() => dispatch({ type: 'dismiss-toast', id: toast.id })}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export function Toasts() {
  const { state } = useStore();
  if (state.toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
