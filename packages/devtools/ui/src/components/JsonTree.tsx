// Hand-rolled collapsible JSON tree + a validating JSON textarea. Primitives
// are colored by type; objects/arrays collapse with an inline preview.

import { memo, useId, useMemo, useState } from 'react';
import { jsonPreview } from '../format';
import { ChevronIcon } from './icons';

function leafClass(value: unknown): string {
  if (value === null || value === undefined) return 'jt-null';
  switch (typeof value) {
    case 'string':
      return 'jt-string';
    case 'number':
    case 'bigint':
      return 'jt-number';
    case 'boolean':
      return 'jt-boolean';
    default:
      return 'jt-other';
  }
}

function leafText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
  /** Depths below this start expanded. */
  openDepth: number;
}

function TreeNode({ name, value, depth, openDepth }: NodeProps) {
  const [open, setOpen] = useState(depth < openDepth);
  const isObject = value !== null && typeof value === 'object';

  if (!isObject) {
    return (
      <div className="jt-leaf">
        {name !== undefined && <span className="jt-key">{name}</span>}
        <span className={`jt-val ${leafClass(value)}`}>{leafText(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="jt-node">
      <button
        type="button"
        className="jt-row"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronIcon open={open} />
        {name !== undefined && <span className="jt-key">{name}</span>}
        <span className="jt-meta">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
        {!open && entries.length > 0 && (
          <span className="jt-preview">{jsonPreview(value, 64)}</span>
        )}
      </button>
      {open && (
        <div className="jt-children">
          {entries.length === 0 ? (
            <div className="jt-leaf">
              <span className="jt-val jt-null">{isArray ? '(empty array)' : '(empty object)'}</span>
            </div>
          ) : (
            entries.map(([key, child]) => (
              <TreeNode
                key={key}
                name={key}
                value={child}
                depth={depth + 1}
                openDepth={openDepth}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export const JsonTree = memo(function JsonTree({
  value,
  openDepth = 2,
}: {
  value: unknown;
  openDepth?: number;
}) {
  return (
    <div className="json-tree">
      <TreeNode value={value} depth={0} openDepth={openDepth} />
    </div>
  );
});

// ----------------------------------------------------------------- JSON input

export interface JsonParse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function parseJson(text: string): JsonParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Value required' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Controlled textarea that validates JSON as it changes. */
export function JsonInput({
  label,
  text,
  onText,
  rows = 4,
  disabled = false,
}: {
  label: string;
  text: string;
  onText(text: string): void;
  rows?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const parse = useMemo(() => parseJson(text), [text]);
  return (
    <div className="json-input">
      <label className="json-input-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={parse.ok || disabled ? 'json-input-area' : 'json-input-area invalid'}
        value={text}
        rows={rows}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => onText(e.target.value)}
      />
      {!parse.ok && !disabled && <div className="json-input-error">{parse.error}</div>}
    </div>
  );
}
