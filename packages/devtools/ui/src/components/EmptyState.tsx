import type { ReactNode } from 'react';

/** Shared empty-panel placeholder: a title plus a one-line hint to get data. */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      <svg
        width="28"
        height="28"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        aria-hidden="true"
      >
        <path d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6Z" />
        <circle cx="8" cy="8" r="1.6" />
      </svg>
      <div className="empty-title">{title}</div>
      {hint !== undefined && <div className="empty-hint">{hint}</div>}
    </div>
  );
}
