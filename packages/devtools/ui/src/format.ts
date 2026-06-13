// Formatting helpers — durations (ms numbers and OTLP unix-nano strings via
// BigInt), relative ages, one-line JSON previews, downloads, clipboard.

export function formatMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Parse an OTLP unix-nano string; malformed input collapses to 0n. */
export function toNano(value: string | undefined): bigint {
  if (value === undefined || value === '') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function nanosToMs(nanos: bigint): number {
  return Number(nanos / 1_000_000n) + Number(nanos % 1_000_000n) / 1e6;
}

/** Adaptive duration for a nanosecond interval: µs, ms or s. */
export function formatNanos(nanos: bigint): string {
  const abs = nanos < 0n ? 0n : nanos;
  const us = Number(abs / 1_000n) + Number(abs % 1_000n) / 1000;
  if (us < 1000) return `${us < 10 ? us.toFixed(1) : Math.round(us)}µs`;
  return formatMs(us / 1000);
}

/** Percentage of `part` within `whole` for waterfall bar geometry (BigInt-safe). */
export function nanoPercent(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const clamped = part < 0n ? 0n : part > whole ? whole : part;
  return Number((clamped * 10_000n) / whole) / 100;
}

export function relativeAge(unixMs: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - unixMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Single-line truncated JSON rendering for dense rows. */
export function jsonPreview(value: unknown, max = 80): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'undefined';
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
